import { askAI } from './providers.js';
const { WORKER_URL, RUNNER_KEY, SESSION_ID, GITHUB_RUN_ID, AI_PROVIDER = 'gemini' } = process.env;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
async function api(path, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(WORKER_URL.replace(/\/$/, '') + path, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'X-Runner-Key': RUNNER_KEY, 'X-Run-Id': GITHUB_RUN_ID },
        body: body ? JSON.stringify({ ...body, sessionId: SESSION_ID }) : undefined
      });
      if ([401, 403, 409].includes(res.status)) { stopping = true; throw new Error('Session no longer active'); }
      if (!res.ok) throw new Error(`Worker error (${res.status})`);
      return await res.json();
    } catch (error) {
      if (stopping || attempt >= 2) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
}
async function main() {
  if (!WORKER_URL || !RUNNER_KEY || !SESSION_ID || !GITHUB_RUN_ID ||
      (AI_PROVIDER === 'openai' ? !process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL : !process.env.GEMINI_API_KEY)) {
    throw new Error('Missing runner configuration');
  }
  await api('/internal/started', {});
  const start = Date.now();
  const query = `?sessionId=${encodeURIComponent(SESSION_ID)}`;
  while (!stopping && Date.now() - start < 4.5 * 60 * 60 * 1000) {
    const { job } = await api('/internal/next' + query);
    if (!job) { await sleep(2000); continue; }
    const { messages, instructions } = await api('/internal/history' + query + '&messageId=' + encodeURIComponent(job.id));
    let answer;
    try { answer = await askAI(messages, instructions); }
    catch (error) {
      console.error(error.message);
      answer = 'Sorry, I could not generate an answer. Please try again.';
    }
    // Retry this write with the SAME answer; never regenerate after a lost acknowledgement.
    await api('/internal/complete', { userMessageId: job.id, answer });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
