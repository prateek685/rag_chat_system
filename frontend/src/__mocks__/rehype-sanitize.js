// CJS stub for rehype-sanitize — used only in the Jest test environment.
// Provides the defaultSchema shape so MessageBubble.tsx can import it without error.
// The actual sanitization security contract is tested in sanitize-schema.spec.ts.
const defaultSchema = {
  tagNames: [
    'a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'hr', 'i', 'input', 'kbd', 'li', 'ol', 'p', 'pre',
    'q', 's', 'section', 'span', 'strong', 'sub', 'sup', 'table', 'tbody',
    'td', 'th', 'thead', 'tr', 'ul',
  ],
  attributes: {
    a: ['href', 'title'],
    code: ['className'],
    input: ['checked', 'disabled', 'type'],
    td: ['align'],
    th: ['align'],
    '*': ['className'],
  },
};

function rehypeSanitize() {}

module.exports = rehypeSanitize;
module.exports.default = rehypeSanitize;
module.exports.defaultSchema = defaultSchema;
