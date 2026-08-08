import assert from 'tjs:assert';

// URLPattern comes from the bundled urlpattern-polyfill (src/js/polyfills/url.js),
// not from ada — ada is built with ADA_INCLUDE_URL_PATTERN=0.
assert.eq(typeof URLPattern, 'function', 'URLPattern global exists');

const pattern = new URLPattern({ pathname: '/books/:id' });

assert.ok(pattern.test('https://example.com/books/123'), 'pattern matches');
assert.ok(!pattern.test('https://example.com/movies/123'), 'pattern rejects non-match');

const match = pattern.exec('https://example.com/books/123');
assert.eq(match.pathname.groups.id, '123', 'exec extracts named group');
