/**
 * Table Metadata - Build collapsible metadata section for table display
 */

/**
 * Convert markdown-style links [text](url) to HTML anchor tags
 * @param {string} text - Text with potential markdown links
 * @returns {string} - HTML with anchor tags
 */
function convertMarkdownLinks(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
}

/**
 * Build the collapsible metadata section HTML
 * @returns {string} - HTML string
 */
function buildMetadataSection() {
  if (!currentFullMetadata) return '';

  const meta = currentFullMetadata;

  // Format updated date
  let updatedStr = '';
  if (meta.updated) {
    try {
      const date = new Date(meta.updated);
      updatedStr = date.toLocaleDateString('no-NO', {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      updatedStr = meta.updated;
    }
  }

  // Build notes HTML
  let notesHtml = '';
  if (meta.note && Array.isArray(meta.note) && meta.note.length > 0) {
    notesHtml = '<dt>Merknader</dt><dd>';
    meta.note.forEach(note => {
      notesHtml += '<p>' + convertMarkdownLinks(note) + '</p>';
    });
    notesHtml += '</dd>';
  }

  // Build contact HTML
  let contactHtml = '';
  if (meta.extension && meta.extension.contact && meta.extension.contact.length > 0) {
    contactHtml = '<dt>Kontakt</dt><dd>';
    meta.extension.contact.forEach(contact => {
      const parts = [];
      if (contact.name) parts.push(escapeHtml(contact.name));
      if (contact.phone) parts.push('tlf: ' + escapeHtml(contact.phone));
      if (contact.mail) {
        parts.push('<a href="mailto:' + escapeHtml(contact.mail) + '">' +
                   escapeHtml(contact.mail) + '</a>');
      }
      contactHtml += '<p>' + parts.join(', ') + '</p>';
    });
    contactHtml += '</dd>';
  }

  // Official statistics flag
  let officialHtml = '';
  if (meta.extension && meta.extension.px && meta.extension.px['official-statistics']) {
    officialHtml = '<dt>Status</dt><dd>Offisiell statistikk</dd>';
  }

  return `
    <div class="table-metadata">
      <h4 class="metadata-toggle-btn" role="button" tabindex="0" aria-expanded="false">
        <span class="metadata-toggle-icon">&#9654;</span> Tabellinfo
      </h4>
      <div class="metadata-content" style="display: none;">
        <dl>
          ${meta.source ? '<dt>Kilde</dt><dd>' + escapeHtml(meta.source) + '</dd>' : ''}
          ${updatedStr ? '<dt>Sist oppdatert</dt><dd>' + updatedStr + '</dd>' : ''}
          ${officialHtml}
          ${notesHtml}
          ${contactHtml}
        </dl>
      </div>
    </div>
  `;
}
