console.log("WhatsApp button script loaded");

// Cache to avoid repeated server calls
const templateCountCache = {};

// Method 1: Standard form hook
frappe.ui.form.on('*', {
    refresh(frm) {
        handle_whatsapp_button(frm);
    },

    after_save(frm) {
        handle_whatsapp_button(frm);
    }
});

// Method 2: Override the Form class's refresh method
(function() {
    if (!frappe.ui.form.Form) {
        return;
    }

    const original_refresh = frappe.ui.form.Form.prototype.refresh;
    
    frappe.ui.form.Form.prototype.refresh = function() {
        // Call original refresh first
        const result = original_refresh.apply(this, arguments);
        
        
        // Add our button logic
        if (this.doc && !this.doc.__islocal) {
            handle_whatsapp_button(this);
        }
        
        return result;
    };
    
})();

// Method 3: Listen to page change events
$(document).on('page-change', function() {
    setTimeout(() => {
        if (cur_frm && cur_frm.doc && !cur_frm.doc.__islocal) {
            handle_whatsapp_button(cur_frm);
        }
    }, 300);
});

// Method 4: Watch for cur_frm changes
(function() {
    let lastFormId = null;
    
    setInterval(() => {
        if (cur_frm && cur_frm.doc) {
            const currentFormId = `${cur_frm.doctype}-${cur_frm.doc.name}`;
            
            if (currentFormId !== lastFormId) {
                lastFormId = currentFormId;
                
                if (!cur_frm.doc.__islocal) {
                    handle_whatsapp_button(cur_frm);
                }
            }
        }
    }, 1000);
    
    console.log("cur_frm watcher installed");
})();

function handle_whatsapp_button(frm) {
    // Skip if no form or document
    if (!frm || !frm.doc) {
        return;
    }
    
    // Skip for new/unsaved documents
    if (frm.doc.__islocal) {
        return;
    }


    // Check if button already exists (avoid duplicates)
    if (frm.__whatsapp_button_added) {
        return;
    }

    const doctype = frm.doctype;

    // Check cache first
    if (templateCountCache.hasOwnProperty(doctype)) {
        const count = templateCountCache[doctype];
        if (count > 0) {
            add_whatsapp_button(frm);
        } else {
            console.log("No templates available for", doctype);
        }
        return;
    }

    // Fetch template count
    console.log("Fetching template count for", doctype);
    frappe.call({
        method: 'frappe.client.get_count',
        args: {
            doctype: 'Whatsapp Template',
            filters: {
                reference_doctype: doctype,
                enabled: 1
            }
        },
        callback: (r) => {
            const count = (r && typeof r.message === 'number') ? r.message : 0;
            
            // Cache the result
            templateCountCache[doctype] = count;
            
            if (count > 0) {
                add_whatsapp_button(frm);
            } else {
                console.log("No templates available for", doctype);
            }
        },
        error: (r) => {
            console.error("Error fetching template count:", r);
        }
    });
}

function add_whatsapp_button(frm) {
    try {
        // Double-check we haven't already added it
        if (frm.__whatsapp_button_added) {
            return;
        }
        
        // Add as a top-level custom button
        frm.add_custom_button('📱 Send via WhatsApp', () => {
            show_whatsapp_dialog(frm, frm.doctype);
        });
        
        // Mark as added
        frm.__whatsapp_button_added = true;
        
    } catch (e) {
        console.error('❌ Failed to add WhatsApp button:', e);
    }
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
    const normalizedPhone = String(phone || '').replace(/[^\d]/g, '');
    if (!normalizedPhone || normalizedPhone.length < 10 || normalizedPhone.length > 15) {
        frappe.msgprint({
            title: __('Invalid Phone Number'),
            message: __('Please provide a valid phone number with country code (10-15 digits).'),
            indicator: 'red'
        });
        return;
    }

    frappe.call({
        method: 'whatsapp_integration.api.api.prepare_whatsapp_presigned_message',
        args: {
            doctype: doctype,
            docname: frm.doc.name
        },
        freeze: true,
        freeze_message: __('🧩 Preparing WhatsApp message and link...'),
        callback: (r) => {
            let msg = r.message && r.message.message ? r.message.message : '';
            if (!msg) {
                frappe.msgprint({
                    title: __('No Message'),
                    message: __('Template rendered empty message.'),
                    indicator: 'orange'
                });
                return;
            }

            // If template is HTML, strip tags to plain text
            const isHtml = r.message && r.message.is_html;
            if (isHtml || /<\/?[a-z][\s\S]*>/i.test(msg)) {
                const tmp = document.createElement('div');
                tmp.innerHTML = msg;
                tmp.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                msg = tmp.textContent || tmp.innerText || '';
                msg = msg.replace(/[\t\x0B\f\r ]+/g, ' ').replace(/\n\s+/g, '\n').trim();
            }

            const encoded = encodeURIComponent(msg);
            const url = `https://wa.me/${normalizedPhone}?text=${encoded}`;

            window.open(url, '_blank');

            frappe.show_alert({
                message: __('Opening WhatsApp for {0}', [contact_name || normalizedPhone]),
                indicator: 'green'
            }, 3);
        },
        error: () => {
            frappe.msgprint({
                title: __('Error'),
                message: __('Failed to prepare WhatsApp message.'),
                indicator: 'red'
            });
        }
    });
}