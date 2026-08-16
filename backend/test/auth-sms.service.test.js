const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeIsraeliPhoneNumberToLocal,
  toIsraeliInternationalPhoneDigits,
  formatAuthCodeSmsMessage,
  buildInforuSmsXmlPayload,
  extractInforuStatusCode,
  extractInforuStatusDescription,
} = require('../dist/services/auth-sms.service');

test('normalizes Israeli phone numbers from local and international formats', () => {
  assert.equal(normalizeIsraeliPhoneNumberToLocal('0546799693'), '0546799693');
  assert.equal(normalizeIsraeliPhoneNumberToLocal('546799693'), '0546799693');
  assert.equal(normalizeIsraeliPhoneNumberToLocal('+972546799693'), '0546799693');
  assert.equal(normalizeIsraeliPhoneNumberToLocal('9720546799693'), '0546799693');
  assert.equal(normalizeIsraeliPhoneNumberToLocal('00972546799693'), '0546799693');
});

test('formats international SMS destination digits consistently', () => {
  assert.equal(toIsraeliInternationalPhoneDigits('0546799693'), '972546799693');
  assert.equal(toIsraeliInternationalPhoneDigits('+972 54-679-9693'), '972546799693');
});

test('builds SMS XML payload without sender when requested', () => {
  const xmlPayload = buildInforuSmsXmlPayload({
    username: 'user',
    apiToken: 'token',
    message: formatAuthCodeSmsMessage('Code: {{code}}', '123456'),
    phone: '972546799693',
    sender: 'Tzafon',
    includeSender: false,
  });

  assert.match(xmlPayload, /<PhoneNumber>972546799693<\/PhoneNumber>/);
  assert.match(xmlPayload, /<Message>Code: 123456<\/Message>/);
  assert.doesNotMatch(xmlPayload, /<Sender>/);
});

test('extracts provider status details from XML responses', () => {
  const response = '<Result><Status>-17</Status><Description>Sender rejected</Description></Result>';
  assert.equal(extractInforuStatusCode(response), '-17');
  assert.equal(extractInforuStatusDescription(response), 'Sender rejected');
});
