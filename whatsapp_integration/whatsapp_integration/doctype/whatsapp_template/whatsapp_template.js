frappe.ui.form.on('Whatsapp Template', {
    refresh(frm) {
        frm.trigger('update_field_help');
    },
    
    reference_doctype(frm) {
        frm.trigger('update_field_help');
        frm.trigger('setup_field_selector');
    },
    
    update_field_help(frm) {
        if (!frm.doc.reference_doctype) {
            frm.fields_dict.available_fields_help.$wrapper.html(
                '<p class="text-muted">Select a DocType to see available fields</p>'
            );
            return;
        }
        
        frappe.call({
            method: 'whatsapp_integration.api.api.get_doctype_fields',
            args: {
                doctype: frm.doc.reference_doctype
            },
            callback: (r) => {
                if (r.message && r.message.length > 0) {
                    let html = `
                        <div class="field-reference-box" style="background: #f8f9fa; padding: 15px; border-radius: 5px; max-height: 400px; overflow-y: auto;">
                            <h6 style="margin-bottom: 15px; color: #495057;">
                                📋 Available Fields for ${frm.doc.reference_doctype}
                                <small class="text-muted" style="font-size: 11px; display: block; margin-top: 5px;">
                                    Click any field to copy. Use as {{ doc.fieldname }} in your template
                                </small>
                            </h6>
                            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px;">
                    `;
                    
                    r.message.forEach((field) => {
                        // Determine icon based on field type
                        let icon = '📄';
                        if (field.fieldtype === 'Currency' || field.fieldtype === 'Float') icon = '💰';
                        else if (field.fieldtype === 'Date' || field.fieldtype === 'Datetime') icon = '📅';
                        else if (field.fieldtype === 'Link') icon = '🔗';
                        else if (field.fieldtype === 'Select') icon = '📋';
                        else if (field.fieldtype === 'Check') icon = '☑️';
                        else if (field.fieldtype === 'Int') icon = '🔢';
                        else if (field.fieldtype === 'Text' || field.fieldtype === 'Small Text') icon = '📝';
                        
                        html += `
                            <div class="field-item" style="background: white; padding: 8px 10px; border-radius: 4px; border: 1px solid #e9ecef; cursor: pointer; transition: all 0.2s;"
                                 data-field="${field.fieldname}"
                                 title="${field.description || field.label}"
                                 onmouseover="this.style.borderColor='#007bff'; this.style.boxShadow='0 2px 4px rgba(0,123,255,0.1)';"
                                 onmouseout="this.style.borderColor='#e9ecef'; this.style.boxShadow='none';">
                                <div style="display: flex; align-items: center; gap: 6px;">
                                    <span style="font-size: 14px;">${icon}</span>
                                    <div style="flex: 1; min-width: 0;">
                                        <div style="font-size: 12px; font-weight: 500; color: #495057; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                            ${field.label}
                                        </div>
                                        <code style="font-size: 10px; color: #6c757d; background: transparent; padding: 0;">
                                            {{ doc.${field.fieldname} }}
                                        </code>
                                    </div>
                                </div>
                            </div>
                        `;
                    });
                    
                    html += `
                            </div>
                            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #dee2e6;">
                                <small style="color: #6c757d; font-size: 11px;">
                                    💡 <strong>Tip:</strong> You can also use conditional logic: 
                                    <code style="background: white; padding: 2px 4px; border-radius: 2px; font-size: 10px;">
                                        {% if doc.status == "Paid" %}Paid{% endif %}
                                    </code>
                                </small>
                            </div>
                        </div>
                    `;
                    
                    frm.fields_dict.available_fields_help.$wrapper.html(html);
                    
                    // Add click to copy functionality
                    frm.fields_dict.available_fields_help.$wrapper.find('.field-item').on('click', function() {
                        let field_name = $(this).data('field');
                        let template = `{{ doc.${field_name} }}`;
                        
                        navigator.clipboard.writeText(template).then(() => {
                            frappe.show_alert({
                                message: `✓ Copied: ${template}`,
                                indicator: 'green'
                            }, 2);
                            
                            // Visual feedback
                            $(this).css('background', '#d4edda');
                            setTimeout(() => {
                                $(this).css('background', 'white');
                            }, 500);
                        });
                    });
                } else {
                    frm.fields_dict.available_fields_help.$wrapper.html(
                        '<p class="text-muted">No fields available for this DocType</p>'
                    );
                }
            }
        });
    },
    
    setup_field_selector(frm) {
        if (!frm.doc.reference_doctype) {
            frm.fields_dict.field_selector.$wrapper.html('');
            return;
        }
        
        let html = `
            <div style="margin-bottom: 10px;">
                <button class="btn btn-xs btn-default" id="insert-field-btn">
                    ➕ Insert Field
                </button>
            </div>
        `;
        
        frm.fields_dict.field_selector.$wrapper.html(html);
        
        $('#insert-field-btn').on('click', () => {
            frappe.call({
                method: 'whatsapp_integration.api.api.get_doctype_fields',
                args: { doctype: frm.doc.reference_doctype },
                callback: (r) => {
                    if (r.message) {
                        let fields = r.message.map(f => ({
                            label: `${f.label} (${f.fieldtype})`,
                            value: f.fieldname,
                            description: f.description
                        }));
                        
                        let d = new frappe.ui.Dialog({
                            title: 'Insert Field',
                            fields: [{
                                fieldname: 'field',
                                fieldtype: 'Select',
                                label: 'Select Field',
                                options: fields,
                                reqd: 1
                            }],
                            primary_action_label: 'Insert',
                            primary_action: (values) => {
                                let field_text = `{{ doc.${values.field} }}`;
                                
                                // Insert into appropriate field
                                let target_field = frm.doc.use_html ? 'response_html' : 'response';
                                let current_value = frm.doc[target_field] || '';
                                frm.set_value(target_field, current_value + field_text);
                                
                                frappe.show_alert({
                                    message: '✓ Field inserted!',
                                    indicator: 'green'
                                }, 2);
                                
                                d.hide();
                            }
                        });
                        
                        d.show();
                    }
                }
            });
        });
    }
});