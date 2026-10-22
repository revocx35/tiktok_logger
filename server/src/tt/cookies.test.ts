import { describe, expect, it } from 'vitest';
import { parseSessionCookies } from './cookies.js';

/**
 * The cookie import is the escape hatch when TikTok asks the container's browser for a captcha or a code. These tests
 * pin what is accepted (DevTools "Copy as cURL" from Firefox and Chrome, a raw Cookie header, a cookie-editor JSON
 * export), which cookies survive, and — importantly — that a signed-out jar is refused with a message that says the
 * browser is not logged in instead of the generic "paste a command" text.
 */

/** A real signed-out Firefox "Copy as cURL" (the homepage): guest cookies only, no sessionid. */
const LOGGED_OUT_CURL = `curl 'https://www.tiktok.com/' \\
  --compressed \\
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0' \\
  -H 'Accept-Language: en-US,en;q=0.9' \\
  -H 'Cookie: ttwid=1%7Cj5wLNQZn1DPsPFvnWQ3UqYlFi4nZ8eBLAklZhgQXgDo%7C1792660076%7Cf47a71f8651164cec31d797f5d8153df1aa057d245352af359737f0d650b17db; tt_chain_token=G5wfcGmCTlNNHkYjul4lrQ==; tiktok_webapp_theme_source=auto; tiktok_webapp_theme=dark; cookie-consent=%7B%22optional%22%3Afalse%7D; tt_csrf_token=9MomoNPt-ZHunjNa1fUnaWxnwltcwiwOgVZs; _waftokenid=eyJ2Ijp7fQ; msToken=XrmkWnnMzX8HC5_oc39sN3zDHepWB7qyikR5VAMG6BJlzb0rbUKZ24hgTpSxZ89tgSjnaRpsGwz9x4Vcl5oVatMyzEJSgZo5v4RxgD7-SuhZA' \\
  -H 'TE: trailers'`;

const SESSION = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const LOGGED_IN_CURL = `curl 'https://www.tiktok.com/messages' \\
  -H 'Cookie: ttwid=1%7Cguest-token; tt_chain_token=G5wfcGmCTlNNHkYjul4lrQ==; sessionid=${SESSION}; sid_guard=${SESSION}%7C1792660076%7C5184000%7CWed%2C+20-Jan-2027; uid_tt=7123456789012345678; uid_tt_ss=7123456789012345678; passport_csrf_token=abc123def456; tt_csrf_token=9MomoNPt-ZHunjNa1fUnaWxnwltcwiwOgVZs; msToken=XeN9vRtV5cB; odin_tt=deadbeefcafe; tiktok_webapp_theme=dark; cookie-consent=%7B%7D' \\
  -H 'TE: trailers'`;

describe('parseSessionCookies', () => {
  it('accepts a signed-in Firefox curl and keeps only TikTok cookies', () => {
    const cookies = parseSessionCookies(LOGGED_IN_CURL);
    const names = cookies.map((c) => c.name).sort();
    expect(names).toEqual([
      'msToken',
      'odin_tt',
      'passport_csrf_token',
      'sessionid',
      'sid_guard',
      'tt_chain_token',
      'tt_csrf_token',
      'ttwid',
      'uid_tt',
      'uid_tt_ss',
    ]);
    expect(cookies.find((c) => c.name === 'sessionid')?.value).toBe(SESSION);
    // the jar's noise (theme, consent) is dropped
    expect(names).not.toContain('cookie-consent');
    expect(names).not.toContain('tiktok_webapp_theme');
  });

  it('says the browser is not logged in for a signed-out jar (the homepage curl)', () => {
    expect(() => parseSessionCookies(LOGGED_OUT_CURL)).toThrowError(/not logged in to TikTok/i);
    expect(() => parseSessionCookies(LOGGED_OUT_CURL)).toThrowError(/sessionid/);
  });

  it('still explains what to paste when nothing parses at all', () => {
    expect(() => parseSessionCookies('hello world')).toThrowError(/Copy as cURL/);
    expect(() => parseSessionCookies('')).toThrowError(/Copy as cURL/);
  });

  it('accepts Chrome "-b" and a raw Cookie header', () => {
    const chrome = `curl 'https://www.tiktok.com/messages' -b 'sessionid=${SESSION}; uid_tt=7123456789012345678'`;
    expect(parseSessionCookies(chrome).map((c) => c.name).sort()).toEqual(['sessionid', 'uid_tt']);

    const header = `Cookie: sessionid=${SESSION}; ttwid=abc`;
    expect(parseSessionCookies(header).map((c) => c.name).sort()).toEqual(['sessionid', 'ttwid']);
  });

  it('accepts a cookie-editor JSON export and drops other domains', () => {
    const json = JSON.stringify([
      { name: 'sessionid', value: SESSION, domain: '.tiktok.com' },
      { name: 'uid_tt', value: '7123456789012345678', domain: 'www.tiktok.com' },
      { name: 'sessionid', value: 'some-other-site-session', domain: '.example.com' },
      { name: 'SID', value: 'google', domain: '.google.com' },
    ]);
    expect(parseSessionCookies(json).map((c) => c.name).sort()).toEqual(['sessionid', 'uid_tt']);
  });

  it('keeps the first of duplicate cookies (two msTokens in one jar)', () => {
    const dup = `Cookie: sessionid=${SESSION}; msToken=first; msToken=second`;
    const ms = parseSessionCookies(dup).find((c) => c.name === 'msToken');
    expect(ms?.value).toBe('first');
  });

  it('refuses cookies that mix two accounts', () => {
    const mixed = `Cookie: sessionid=${SESSION}; uid_tt=7111111111111111111; sid_guard=7222222222222222222%7C1792660076`;
    expect(() => parseSessionCookies(mixed)).toThrowError(/two different accounts/);
  });

  it('refuses a sessionid that is too short to be real', () => {
    expect(() => parseSessionCookies('Cookie: sessionid=abc')).toThrowError(/not logged in/i);
  });
});
