// Errors with a code, so the browser can show them in the user's language.

const I18N = require('./public/i18n');

/** Creates an Error whose message is English but which also carries a translation key */
function coded(code, vars = {}) {
  const err = new Error(I18N.translate('en', `err.${code}`, vars));
  err.code = code;
  err.vars = vars;
  return err;
}

/** JSON body for an error response */
function errBody(err) {
  return { error: err.message, code: err.code, vars: err.vars };
}

module.exports = { coded, errBody };
