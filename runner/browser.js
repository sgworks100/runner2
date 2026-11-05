// Gemini UI selectors are isolated here because the website can change independently.
export const SELECTORS = Object.freeze({
  input: 'div[contenteditable="true"][role="textbox"], rich-textarea div[contenteditable="true"]',
  response: 'model-response',
  text: '.markdown, .model-response-text',
  stop: 'button[aria-label*="Stop"], button[aria-label*="stop"], button[data-test-id="stop-response-button"]',
  completion: 'button[aria-label*="Copy"], button[aria-label*="copy"], button[data-test-id="copy-button"]',
  challenge: 'iframe[src*="recaptcha"], iframe[src*="challenge"], #captcha-form',
  error: '[role="alert"], .error-message'
});
const messages = {
  unavailable: 'Gemini is unavailable without signing in, or its interface has changed. This session has ended.',
  challenge: 'Gemini requires sign-in or an access check. This session has ended.',
  timeout: 'Gemini did not finish responding in time. This session has ended.',
  closed: 'The Gemini browser closed unexpectedly. This session has ended.',
  failed: 'Gemini could not process this message. This session has ended.'
};
export class BrowserError extends Error {
  constructor(code) { super(messages[code] || messages.failed); this.code = code; }
}
// Executed in the page. Never include prompts, cookies, or page contents in logs.
export function snapshotDOM({ selectors, baseline = 0 }) {
  const visible = el => !!el && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const any = selector => [...document.querySelectorAll(selector)].some(visible);
  const responses = [...document.querySelectorAll(selectors.response)];
  const response = responses.length > baseline ? responses[responses.length - 1] : null;
  const text = response?.querySelector(selectors.text);
  return {
    count: responses.length,
    text: text?.innerText?.trim() || '',
    input: any(selectors.input),
    stopped: !any(selectors.stop),
    completed: !!response && [...response.querySelectorAll(selectors.completion)].some(visible),
    blocked: /accounts\.google\./.test(location.hostname) || any(selectors.challenge),
    error: any(selectors.error)
  };
}
// A stable response alone is insufficient: require a completion control or an observed
// generation stop control that has disappeared. Never return an existing old response.
export function observe(state, snapshot, now, stableMs) {
  if (!snapshot.stopped) state.sawGenerating = true;
  if (snapshot.text !== state.text) { state.text = snapshot.text; state.changedAt = now; }
  if (!snapshot.stopped) state.changedAt = now;
  return !!snapshot.text && snapshot.stopped && (snapshot.completed || state.sawGenerating) && now - state.changedAt >= stableMs;
}
export class GeminiBrowser {
  constructor({ launch, timeoutMs = 120000, stableMs = 2000, pollMs = 250, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { launch, timeoutMs, stableMs, pollMs, now, sleep });
    this.closed = false; this.processing = false;
  }
  async initialize() {
    try {
      const launch = this.launch || (async options => (await import('playwright')).chromium.launch(options));
      this.browser = await launch({ headless: true });
      if (this.closed) { await this.browser.close(); throw new BrowserError('closed'); }
      this.context = await this.browser.newContext({ locale: 'en-US' });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(10000);
      await this.page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 60000 });
      const deadline = this.now() + 30000;
      while (!this.closed && this.now() < deadline) {
        const snapshot = await this.snapshot();
        if (snapshot.blocked) throw new BrowserError('challenge');
        // A sign-in link can coexist with usable signed-out chat; do not reject it.
        if (snapshot.input && !snapshot.error) return;
        await this.sleep(this.pollMs);
      }
      throw new BrowserError(this.closed ? 'closed' : 'unavailable');
    } catch (error) {
      await this.close();
      throw error instanceof BrowserError ? error : new BrowserError('unavailable');
    }
  }
  async snapshot(baseline = 0) {
    if (this.closed || !this.page || this.page.isClosed()) throw new BrowserError('closed');
    return this.page.evaluate(snapshotDOM, { selectors: SELECTORS, baseline });
  }
  async ask(message, instructions) {
    if (this.processing) throw new BrowserError('failed');
    this.processing = true;
    try {
      const initial = await this.snapshot();
      if (initial.blocked) throw new BrowserError('challenge');
      if (!initial.input || initial.error) throw new BrowserError('unavailable');
      const input = this.page.locator(SELECTORS.input).filter({ visible: true }).first();
      await input.fill(`${instructions || 'You are a helpful AI assistant.'}\n\nUser message:\n${message}`);
      // Capture after filling, before Enter. Never automatically repeat an uncertain submission.
      const baseline = (await this.snapshot()).count;
      await input.press('Enter');
      const deadline = this.now() + this.timeoutMs;
      const state = { text: '', changedAt: this.now(), sawGenerating: false };
      while (!this.closed && this.now() < deadline) {
        const snapshot = await this.snapshot(baseline);
        if (snapshot.blocked) throw new BrowserError('challenge');
        if (snapshot.error) throw new BrowserError('failed');
        if (!snapshot.stopped) state.sawGenerating = true;
        if (snapshot.count > baseline && observe(state, snapshot, this.now(), this.stableMs)) return snapshot.text.slice(0, 20000);
        await this.sleep(this.pollMs);
      }
      throw new BrowserError(this.closed ? 'closed' : 'timeout');
    } catch (error) {
      // Continuing after an uncertain turn could associate a later response with the wrong job.
      await this.close();
      throw error instanceof BrowserError ? error : new BrowserError('failed');
    } finally { this.processing = false; }
  }
  async close() {
    this.closed = true;
    await this.browser?.close().catch(() => {});
  }
}
