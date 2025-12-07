import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
import frappe
import requests
from frappe import _
from jinja2 import Template

@frappe.whitelist()
def get_doctype_fields(doctype):
    """Get all fields for a doctype that can be used in templates, organized by category"""
    meta = frappe.get_meta(doctype)
    
    # Field types to exclude
    excluded_fieldtypes = [
        'Table', 'Table MultiSelect', 'HTML', 'HTML Editor', 'Button',
        'Section Break', 'Column Break', 'Tab Break', 'Heading', 'Code',
        'Password', 'Attach', 'Attach Image', 'Signature', 'Geolocation',
        'Duration', 'Rating', 'Color', 'Icon', 'Barcode', 'Image'
    ]
    
    # System fields to exclude
    excluded_fieldnames = [
        'modified', 'modified_by', 'creation', 'owner', 'docstatus', 
        'idx', 'parent', 'parenttype', 'parentfield', '_user_tags', 
        '_comments', '_assign', '_liked_by', 'workflow_state', 
        'amended_from', 'print_language'
    ]
    
    # Categorize fields for better organization
    important_fields = []
    date_fields = []
    amount_fields = []
    text_fields = []
    other_fields = []
    
    for field in meta.fields:
        # Skip excluded field types and names
        if (field.fieldtype in excluded_fieldtypes or 
            field.fieldname in excluded_fieldnames or 
            field.hidden or 
            field.fieldname.startswith('_')):
            continue
        
        field_info = {
            'fieldname': field.fieldname,
            'label': field.label or field.fieldname.replace('_', ' ').title(),
            'fieldtype': field.fieldtype,
            'description': field.description or ''
        }
        
        # Categorize by field type for better organization
        if field.fieldtype in ['Currency', 'Float', 'Int', 'Percent']:
            # Check if it's an important amount field
            if any(keyword in field.fieldname.lower() for keyword in ['total', 'amount', 'price', 'grand', 'net', 'tax', 'discount']):
                amount_fields.append(field_info)
            else:
                other_fields.append(field_info)
                
        elif field.fieldtype in ['Date', 'Datetime', 'Time']:
            date_fields.append(field_info)
            
        elif any(keyword in field.fieldname.lower() for keyword in ['customer', 'party', 'name', 'title', 'subject']):
            # Important identifier fields
            important_fields.append(field_info)
            
        elif field.fieldtype in ['Text', 'Small Text', 'Long Text', 'Text Editor']:
            text_fields.append(field_info)
            
        else:
            other_fields.append(field_info)
    
    # Add document ID at the top
    important_fields.insert(0, {
        'fieldname': 'name',
        'label': 'Document ID',
        'fieldtype': 'Data',
        'description': 'Unique document identifier'
    })
    
    # Combine all categories in order of importance
    all_fields = (
        important_fields +  # Most important first
        amount_fields +     # Then amounts
        date_fields +       # Then dates
        other_fields +      # Then other structured data
        text_fields         # Text fields last (usually long)
    )
    
    return all_fields

@frappe.whitelist()
def get_whatsapp_contacts(doctype, docname):
    """Get WhatsApp enabled contacts for a document"""
    doc = frappe.get_doc(doctype, docname)
    contacts = []
    
    # Get customer field (might be 'customer' or 'party_name' etc.)
    customer_field = None
    if hasattr(doc, 'customer'):
        customer_field = 'customer'
        customer = doc.customer
    elif hasattr(doc, 'party_name'):
        customer_field = 'party_name'
        customer = doc.party_name
    
    if not customer_field:
        frappe.throw(_("No customer field found in this document"))
    
    # Get all contacts linked to this customer via Dynamic Link
    contact_links = frappe.get_all('Dynamic Link',
        filters={
            'link_doctype': 'Customer',
            'link_name': customer,
            'parenttype': 'Contact'
        },
        fields=['parent'],
        distinct=True
    )
    
    # Fetch contacts and filter WhatsApp-enabled phone numbers
    for link in contact_links:
        try:
            contact = frappe.get_doc('Contact', link.parent)
            
            # Check each phone number in the contact
            for phone in contact.phone_nos:
                if phone.custom_is_whatsapp_enabled and phone.phone:
                    contact_display = contact.first_name or contact.name
                    if contact.last_name:
                        contact_display += ' ' + contact.last_name
                    
                    contacts.append({
                        'contact_name': contact.name,
                        'contact_display': contact_display,
                        'phone': phone.phone,
                        'is_primary': phone.is_primary_mobile_no or False
                    })
        except Exception as e:
            frappe.log_error(message=f"Error fetching contact {link.parent}: {str(e)}", title="WhatsApp Get Contacts")
            continue
    
    if not contacts:
        frappe.msgprint(
            _("No WhatsApp-enabled phone numbers found for customer {0}. Please enable WhatsApp on at least one contact number.").format(customer),
            indicator='orange'
        )
    
    return contacts


@frappe.whitelist()
def send_whatsapp_message(doctype, docname, phone, contact_name=None):
    """Send WhatsApp message using template"""
    # Get the document
    doc = frappe.get_doc(doctype, docname)
    
    # Get the WhatsApp template for this doctype
    templates = frappe.get_all('Whatsapp Template',
        filters={
            'reference_doctype': doctype,
            'enabled': 1
        },
        limit=1
    )
    
    if not templates:
        frappe.throw(_("No WhatsApp template found for {0}").format(doctype))
    
    template_doc = frappe.get_doc('Whatsapp Template', templates[0].name)
    
    # Render the message template
    try:
        if template_doc.use_html:
            jinja_template = Template(template_doc.response_html)
        else:
            jinja_template = Template(template_doc.response)
        
        message = jinja_template.render(doc=doc)
    except Exception as e:
        frappe.log_error(f"Template rendering failed: {str(e)}", "WhatsApp Template Render")
        frappe.throw(_("Failed to render message template: {0}").format(str(e)))
    
    # Clean and format phone number
    phone = format_whatsapp_phone(phone)
    
    # Send message
    try:
        if template_doc.send_attachment:
            # Send with PDF attachment
            result = send_with_attachment(doc, phone, message, doctype)
        else:
            # Send text only
            result = send_text_message(phone, message)
        
        # Log the activity in timeline
        frappe.get_doc({
            'doctype': 'Comment',
            'comment_type': 'Info',
            'reference_doctype': doctype,
            'reference_name': docname,
            'content': f'WhatsApp message sent to {contact_name or phone}'
        }).insert(ignore_permissions=True)
        
        return result
        
    except Exception as e:
        frappe.log_error(f"WhatsApp send failed: {str(e)}", "WhatsApp Integration")
        frappe.throw(_("Failed to send WhatsApp message: {0}").format(str(e)))


def format_whatsapp_phone(phone):
    """
    Format phone number for WhatsApp
    - Remove all special characters
    - Add country code if missing
    - Handle Indian numbers (default country code: 91)
    """
    if not phone:
        frappe.throw(_("Phone number is required"))
    
    # Remove all non-numeric characters
    phone = ''.join(filter(str.isdigit, phone))
    
    if not phone:
        frappe.throw(_("Invalid phone number format"))
    
    # Get default country code from system settings or use 91 (India)
    default_country_code = frappe.db.get_single_value('System Settings', 'country') 
    
    # Map common countries to their codes
    country_codes = {
        'India': '91',
        'United States': '1',
        'United Kingdom': '44',
        'United Arab Emirates': '971',
        'Saudi Arabia': '966',
        'Singapore': '65',
        'Australia': '61',
        'Canada': '1',
    }
    
    # Default to India if not found
    default_code = country_codes.get(default_country_code, '91')
    
    # Check if phone already has country code
    # If phone starts with common country codes, don't add prefix
    common_prefixes = ['1', '44', '91', '971', '966', '65', '61', '86', '81']
    
    has_country_code = False
    for prefix in common_prefixes:
        if phone.startswith(prefix) and len(phone) > len(prefix) + 8:
            has_country_code = True
            break
    
    # Add country code if not present
    if not has_country_code:
        # Special handling for Indian numbers
        if len(phone) == 10:  # Indian mobile number without country code
            phone = default_code + phone
        elif len(phone) < 10:
            frappe.throw(_("Phone number is too short. Please provide a valid phone number with country code."))
    
    # Validate final length (should be between 10-15 digits)
    if len(phone) < 10 or len(phone) > 15:
        frappe.throw(_("Invalid phone number length. Phone number should be between 10-15 digits including country code."))
    
    return phone


def send_text_message(phone, message):
    """Send text-only WhatsApp message"""
    base_url = get_whatsapp_server_url()
    wa_payload = {
        "args": {
            "to": f"{phone}@c.us",
            "content": message
        }
    }
    
    try:
        response = requests.post(f"{base_url}/sendText", json=wa_payload, timeout=30)
        response.raise_for_status()
        return {"success": True, "response": response.json()}
    except requests.exceptions.RequestException as e:
        frappe.log_error(f"WhatsApp text send failed: {str(e)}", "WhatsApp Send Text")
        raise


def send_with_attachment(doc, phone, caption, doctype):
    """Send WhatsApp message by uploading PDF to S3 and sharing a 12h presigned URL."""
    
    pdf_content = generate_pdf_bytes(doc, doctype)
    
    # Upload PDF to S3 and get a short-lived presigned URL
    try:
        s3_url = upload_pdf_and_get_presigned_url(doc, doctype, pdf_content, expiry_seconds=12 * 60 * 60)
    except Exception as e:
        err = str(e)
        frappe.log_error(message=err, title="WhatsApp S3 Upload")
        frappe.throw(_("Failed to upload to S3 or create presigned URL: {0}").format(err))

    # Send text containing the link and an expiry notice
    link_notice = _("This link will expire in 12 hours.")
    message_with_link = f"{caption}\n\n{_('Download PDF')}: {s3_url}\n{link_notice}"

    try:
        return send_text_message(phone, message_with_link)
    except Exception as e:
        frappe.log_error(f"WhatsApp text with S3 link failed: {str(e)}", "WhatsApp Send Text")
        frappe.throw(_("Failed to send WhatsApp message with link: {0}").format(str(e)))


def generate_pdf_bytes(doc, doctype):
    """Generate a PDF for the doc and return its bytes."""
    print_format = "Standard"
    try:
        meta = frappe.get_meta(doctype)
        if hasattr(meta, 'default_print_format') and meta.default_print_format:
            print_format = meta.default_print_format
    except Exception:
        pass

    site_url = frappe.utils.get_url()
    pdf_url = f"{site_url}/api/method/frappe.utils.print_format.download_pdf"

    params = {
        "doctype": doctype,
        "name": doc.name,
        "format": print_format,
        "no_letterhead": 0
    }

    try:
        response = requests.get(
            pdf_url,
            params=params,
            cookies={"sid": frappe.local.session.sid},
            timeout=30
        )
        response.raise_for_status()
        pdf_content = response.content

        if not pdf_content:
            frappe.throw(_("Failed to generate PDF - empty content returned"))

        return pdf_content

    except requests.exceptions.RequestException as e:
        frappe.log_error(f"PDF generation failed: {str(e)}", "WhatsApp PDF Generation")
        frappe.throw(_("Failed to download PDF: {0}").format(str(e)))


def upload_pdf_and_get_presigned_url(doc, doctype, pdf_bytes, expiry_seconds=43200):
    """Upload PDF bytes to S3 and return a presigned URL valid for `expiry_seconds`.

    Configuration is read from the doctype `Whatsapp S3 Configuration`.
    Expected fields: `aws_access_key_id`, `aws_secret_access_key`, `bucket_name`, `region_name` (optional), `folder` (optional).
    """
    cfg = get_whatsapp_s3_config()

    aws_access_key_id = cfg.get('aws_access_key_id')
    aws_secret_access_key = cfg.get('aws_secret_access_key')
    bucket_name = cfg.get('bucket_name')
    # Explicit AWS endpoint from region to avoid signing host mismatches
    endpoint_url = None
    signature_version = cfg.get('signature_version') or 's3v4'
    folder = cfg.get('folder') or ''

    # Region: explicit from config; needed for correct SigV4 host
    region_name = cfg.get('region_name') or None
    if region_name:
        endpoint_url = f"https://s3.{region_name}.amazonaws.com"

    if not aws_access_key_id or not aws_secret_access_key or not bucket_name:
        frappe.throw(_("Missing S3 configuration. Please set AWS Key, Secret, and Bucket in Whatsapp S3 Configuration."))
    if not region_name:
        frappe.throw(_("Missing S3 region. Please set Region Name in Whatsapp S3 Configuration."))

    # Create S3 client with explicit region and optional path-style when bucket has dots
    try:
        config_kwargs = {}
        if signature_version:
            config_kwargs['signature_version'] = signature_version
        # Force path-style if bucket has dots to avoid signature mismatch
        if '.' in bucket_name:
            config_kwargs['s3'] = {'addressing_style': 'path'}

        client_config = Config(**config_kwargs) if config_kwargs else None
        s3_client = boto3.client(
            's3',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            region_name=region_name,
            endpoint_url=endpoint_url,
            config=client_config
        )
    except (BotoCoreError, ClientError) as e:
        frappe.throw(_("Failed to create S3 client: {0}").format(str(e)))

    # Object key
    safe_doctype = doctype.replace(' ', '_')
    object_name = f"{safe_doctype}_{doc.name}.pdf"
    folder_clean = folder.strip('/') if isinstance(folder, str) else ''
    key = f"{folder_clean}/{object_name}" if folder_clean else object_name

    # Upload
    try:
        s3_client.put_object(
            Bucket=bucket_name,
            Key=key,
            Body=pdf_bytes,
            ContentType='application/pdf'
        )
    except (BotoCoreError, ClientError) as e:
        frappe.throw(_("Failed to upload to S3: {0}").format(str(e)))

    # Presign URL
    try:
        url = s3_client.generate_presigned_url(
            'get_object',
            Params={'Bucket': bucket_name, 'Key': key},
            ExpiresIn=int(expiry_seconds)
        )
        return url
    except (BotoCoreError, ClientError) as e:
        frappe.throw(_("Failed to generate presigned URL: {0}").format(str(e)))


def get_whatsapp_s3_config():
    """Fetch configuration from single doctype `Whatsapp S3 Configuration`.
    Returns a dict of relevant fields.
    """
    # DocType is Single, so name equals doctype
    cfg_doc = frappe.get_doc('Whatsapp S3 Configuration')

    # Safely extract attributes; fieldnames follow the DocType JSON
    def _get(name, default=None):
        return getattr(cfg_doc, name, default)

    return {
        'aws_access_key_id': _get('aws_key'),
        'aws_secret_access_key': _get('aws_secret'),
        'bucket_name': _get('bucket'),
        'region_name': _get('region_name'),  # optional, may be absent
        'folder': _get('folder'),            # optional, may be absent
        'endpoint_url': None,                # let boto3 construct endpoint
        'signature_version': _get('signature_version'),
    }


@frappe.whitelist()
def render_whatsapp_message(doctype, docname):
    """Render WhatsApp message from the selected template for a doctype and document.
    Returns the rendered text and a flag indicating HTML usage.
    """
    doc = frappe.get_doc(doctype, docname)

    templates = frappe.get_all('Whatsapp Template',
        filters={
            'reference_doctype': doctype,
            'enabled': 1
        },
        limit=1
    )

    if not templates:
        frappe.throw(_("No WhatsApp template found for {0}").format(doctype))

    template_doc = frappe.get_doc('Whatsapp Template', templates[0].name)

    try:
        if template_doc.use_html:
            jinja_template = Template(template_doc.response_html)
        else:
            jinja_template = Template(template_doc.response)

        message = jinja_template.render(doc=doc)
    except Exception as e:
        frappe.log_error(f"Template rendering failed: {str(e)}", "WhatsApp Template Render")
        frappe.throw(_("Failed to render message template: {0}").format(str(e)))

    return {
        'message': message,
        'is_html': bool(template_doc.use_html),
    }


@frappe.whitelist()
def prepare_whatsapp_presigned_message(doctype, docname):
    """Render template, upload PDF to S3, and return message with a 12h presigned link."""
    doc = frappe.get_doc(doctype, docname)

    templates = frappe.get_all('Whatsapp Template',
        filters={
            'reference_doctype': doctype,
            'enabled': 1
        },
        limit=1
    )

    if not templates:
        frappe.throw(_("No WhatsApp template found for {0}").format(doctype))

    template_doc = frappe.get_doc('Whatsapp Template', templates[0].name)

    try:
        if template_doc.use_html:
            jinja_template = Template(template_doc.response_html)
        else:
            jinja_template = Template(template_doc.response)

        caption = jinja_template.render(doc=doc)
    except Exception as e:
        frappe.log_error(f"Template rendering failed: {str(e)}", "WhatsApp Template Render")
        frappe.throw(_("Failed to render message template: {0}").format(str(e)))

    pdf_bytes = generate_pdf_bytes(doc, doctype)

    try:
        s3_url = upload_pdf_and_get_presigned_url(doc, doctype, pdf_bytes, expiry_seconds=12 * 60 * 60)
    except Exception as e:
        err = str(e)
        frappe.log_error(message=err, title="WhatsApp S3 Upload")
        frappe.throw(_("Failed to upload to S3 or create presigned URL: {0}").format(err))

    link_notice = _("This link will expire in 12 hours.")
    message_with_link = f"{caption}\n\n{_('Download PDF')}: {s3_url}\n{link_notice}"

    return {
        'message': message_with_link,
        'presigned_url': s3_url,
        'is_html': bool(template_doc.use_html),
    }


def get_whatsapp_server_url():
    """Resolve WhatsApp server base URL as the current site URL.
    Uses `frappe.utils.get_url()` so the WhatsApp server is the same host:port
    as the running site (e.g., 127.0.0.1:8001, 127.0.0.1:8002, whatsapp.local:8000).

    If you need to override, you can still set `frappe.conf.whatsapp_server_url`
    or `WHATSAPP_SERVER_URL`, but by default we follow the site URL.
    """
    # Prefer explicit overrides if provided
    try:
        override = getattr(frappe.conf, 'whatsapp_server_url', None)
    except Exception:
        override = None
    if override:
        return override.rstrip('/')

    env = os.environ.get('WHATSAPP_SERVER_URL')
    if env:
        return env.rstrip('/')

    # Default: site base URL
    site_url = frappe.utils.get_url().rstrip('/')
    return site_url
