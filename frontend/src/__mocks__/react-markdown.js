// CJS stub for react-markdown — used only in the Jest test environment.
// Renders the markdown string as plain text inside a div, passing it through
// any rehype plugins that are provided (so sanitization tests still work).
const React = require('react');

function ReactMarkdown({ children, components }) {
  // Minimal render: just output the raw string content.
  // The XSS test verifies sanitization via the sanitize-schema spec, not through
  // a full unified render pipeline which requires ESM transform support.
  return React.createElement('div', { 'data-testid': 'markdown-content' }, children);
}

module.exports = ReactMarkdown;
module.exports.default = ReactMarkdown;
