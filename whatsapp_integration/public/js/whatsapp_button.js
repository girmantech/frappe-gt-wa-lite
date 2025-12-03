// Universal WhatsApp Button - Automatically adds button to any form with a template

frappe.ui.form.on('*', {
    refresh(frm) {
        // Don't run on new documents
        if (frm.doc.__islocal) {
            return;
        }
        
        // Check if template exists for this doctype
        frappe.call({
            method: 'frappe.client.get_count',
            args: {
                doctype: 'Whatsapp Template',
                filters: {
                    reference_doctype: frm.doctype,
                    enabled: 1
                }
            },
            callback: (r) => {
                if (r.message > 0) {
                    add_whatsapp_button(frm);
                }
            }
        });
    }
});

function add_whatsapp_button(frm) {
    frm.add_custom_button('📱 Send via WhatsApp', () => {
        show_whatsapp_dialog(frm, frm.doctype);
    }, __('Send Options'));
}

function show_whatsapp_dialog(frm, doctype) {
    frappe.call({
        method: 'whatsapp_integration.api.api.get_whatsapp_contacts',
        args: {
            doctype: doctype,
            docname: frm.doc.name
        },
        callback: (r) => {
            if (!r.message || r.message.length === 0) {
                frappe.msgprint({
                    title: __('No WhatsApp Contacts'),
                    message: __('No WhatsApp-enabled phone numbers found for this customer.'),
                    indicator: 'orange'
                });
                return;
            }
            
            let contacts = r.message;
            
            if (contacts.length === 1) {
                send_whatsapp(frm, doctype, contacts[0].phone, contacts[0].contact_display);
            } else {
                let contact_options = contacts.map(c => ({
                    label: `${c.contact_display} (${c.phone})${c.is_primary ? ' ⭐' : ''}`,
                    value: c.phone,
                    contact_name: c.contact_display
                }));
                
                let d = new frappe.ui.Dialog({
                    title: __('Choose WhatsApp Contact'),
                    fields: [{
                        fieldname: 'contact',
                        fieldtype: 'Select',
                        label: 'Select Contact',
                        options: contact_options.map(c => c.label),
                        reqd: 1,
                        description: '⭐ = Primary mobile number'
                    }],
                    primary_action_label: __('Send Message'),
                    primary_action: (values) => {
                        let selected = contact_options.find(c => c.label === values.contact);
                        if (selected) {
                            d.hide();
                            send_whatsapp(frm, doctype, selected.value, selected.contact_name);
                        }
                    }
                });
                d.show();
            }
        }
    });
}

function send_whatsapp(frm, doctype, phone, contact_name) {
    frappe.confirm(
        `Send WhatsApp message to <strong>${contact_name}</strong> (${phone})?`,
        function() {
            frappe.call({
                method: 'whatsapp_integration.api.api.send_whatsapp_message',
                args: {
                    doctype: doctype,
                    docname: frm.doc.name,
                    phone: phone,
                    contact_name: contact_name
                },
                freeze: true,
                freeze_message: __('📤 Sending WhatsApp message...'),
                callback: (r) => {
                    if (r.message && r.message.success) {
                        frappe.show_alert({
                            message: __('✅ Message sent to {0}!', [contact_name]),
                            indicator: 'green'
                        }, 5);
                        frm.reload_doc();
                    }
                },
                error: (r) => {
                    frappe.msgprint({
                        title: __('Error'),
                        message: __('Failed to send WhatsApp message.'),
                        indicator: 'red'
                    });
                }
            });
        }
    );
}