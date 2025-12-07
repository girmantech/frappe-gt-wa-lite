// Universal WhatsApp Button - Automatically adds button to any form with a template

console.log("WhatsApp button script loaded (desk)");
// Cache template counts per doctype to avoid repeated server calls
window.__waTemplateCountCache = window.__waTemplateCountCache || {};

frappe.ui.form.on('*', {
    refresh(frm) {
        try {
            // Basic guards
            if (!frm || !frm.doc) return;
            console.log("WhatsApp refresh for", frm.doctype, frm.doc.name, "islocal:", frm.doc.__islocal);

            if (frm.doc.__islocal) {
                return;
            }

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
                    const count = (r && typeof r.message === 'number') ? r.message : 0;
                    console.log("Template count for", frm.doctype, "=", count);
                    if (count > 0 && !frm.__whatsapp_button_added) {
                        add_whatsapp_button(frm);
                    }
                }
            });
        } catch (e) {
            // Fail-safe: never break the form UI
            console.warn("WhatsApp button refresh error:", e);
        }
    }
});

// Fallback: also hook via route changes in case '*' handler doesn't fire in some contexts
if (frappe.router && typeof frappe.router.on === 'function') {
    frappe.router.on('change', () => {
        try {
            const route = frappe.get_route();
            // Expecting ["Form", doctype, name]
            if (!route || route[0] !== 'Form') return;

            const doctype = route[1];
            const name = route[2];

            const frm = cur_frm; // current form
            if (!frm || frm.doctype !== doctype || frm.docname !== name) return;
            if (!frm.doc || frm.doc.__islocal) return;

            // Bind once per form instance
            if (!frm.__whatsapp_route_bound) {
                frm.__whatsapp_route_bound = true;
                const handler = () => {
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
                            const count = (r && typeof r.message === 'number') ? r.message : 0;
                            console.log('[route] Template count for', frm.doctype, '=', count);
                            if (count > 0 && !frm.__whatsapp_button_added) {
                                add_whatsapp_button(frm);
                            }
                        }
                    });
                };

                // Run now and on every refresh
                handler();
                // In some builds frm.on may not exist; rely on handler + polling below
            }
        } catch (e) {
            console.warn('WhatsApp route hook error:', e);
        }
    });
}

// Last-resort fallback: poll for cur_frm and bind once per form
(function bind_whatsapp_button_with_polling() {
    // Use a single interval and clear it as soon as we know the outcome
    if (window.__waPollHandle) return; // prevent multiple pollers

    let attempts = 0;
    const maxAttempts = 40; // up to ~20s at 500ms

    window.__waPollHandle = setInterval(() => {
        attempts += 1;
        try {
            const route = (typeof frappe.get_route === 'function') ? frappe.get_route() : null;
            if (!route || route[0] !== 'Form') {
                // Not on a Form route; stop polling
                clearInterval(window.__waPollHandle);
                window.__waPollHandle = null;
                return;
            }

            const frm = (typeof cur_frm !== 'undefined') ? cur_frm : null;
            if (!frm || !frm.doc) return; // wait for form to be ready

            if (frm.__whatsapp_button_added) {
                clearInterval(window.__waPollHandle);
                window.__waPollHandle = null;
                return;
            }

            if (frm.doc.__islocal) return; // wait until saved

            const doctype = frm.doctype;
            const cached = window.__waTemplateCountCache[doctype];
            const handleCount = (count) => {
                window.__waTemplateCountCache[doctype] = count;
                console.log('[poll] Template count for', doctype, '=', count);
                if (count > 0 && !frm.__whatsapp_button_added) {
                    add_whatsapp_button(frm);
                    frm.__whatsapp_button_added = true;
                }
                // Either way, we learned the outcome for this doctype; stop polling
                clearInterval(window.__waPollHandle);
                window.__waPollHandle = null;
            };

            if (typeof cached === 'number') {
                handleCount(cached);
                return;
            }

            // Fetch once, then cache
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
                    handleCount(count);
                }
            });
        } catch (e) {
            console.warn('WhatsApp polling bind error:', e);
        } finally {
            if (attempts >= maxAttempts && window.__waPollHandle) {
                clearInterval(window.__waPollHandle);
                window.__waPollHandle = null;
            }
        }
    }, 500);
})();

function add_whatsapp_button(frm) {
    try {
        console.log("Adding WhatsApp button on", frm.doctype);
        // Add as a top-level custom button to ensure visibility
        const btn = frm.add_custom_button('📱 Send via WhatsApp', () => {
            show_whatsapp_dialog(frm, frm.doctype);
        });
        // Mark as added only when call didn't throw
        frm.__whatsapp_button_added = true;
        return btn;
    } catch (e) {
        console.warn('Failed to add WhatsApp button:', e);
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
    // Client-side sanity check to avoid needless server calls with bad numbers
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

            // If template is HTML or Text Editor produced HTML, strip tags to plain text
            const isHtml = r.message && r.message.is_html;
            if (isHtml || /<\/?[a-z][\s\S]*>/i.test(msg)) {
                const tmp = document.createElement('div');
                tmp.innerHTML = msg;
                // Replace <br> with newlines before text extraction
                tmp.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
                // Get readable text content
                msg = tmp.textContent || tmp.innerText || '';
                // Collapse excessive whitespace
                msg = msg.replace(/[\t\x0B\f\r ]+/g, ' ').replace(/\n\s+/g, '\n').trim();
            }

            // Build WhatsApp Web URL (wa.me)
            const encoded = encodeURIComponent(msg);
            const url = `https://wa.me/${normalizedPhone}?text=${encoded}`;

            // Open in new tab
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