export async function askAI(history, instructions, env = process.env) {
  const provider = env.AI_PROVIDER || 'gemini';
  // Bound context size while retaining the newest question.
  let size = 0;
  const recent = [];
  for (const message of [...history].reverse()) {
    if (size + message.content.length > 60000 && recent.length) break;
    recent.unshift(message); size += message.content.length;
  }
  while (recent.length > 1 && recent[0].role === 'assistant') recent.shift();
  const openai = provider === 'openai';
  if (!['openai', 'gemini'].includes(provider)) throw new Error('Unsupported AI_PROVIDER');
  const model = openai ? env.OPENAI_MODEL : (env.GEMINI_MODEL || 'gemini-2.5-flash');
  const key = openai ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  if (!key || !model) throw new Error(`Missing ${provider} key or model`);
  const res = await fetch(openai ? 'https://api.openai.com/v1/responses' :
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', ...(openai ? { Authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }) },
    body: JSON.stringify(openai ? {
      model, instructions, input: recent, max_output_tokens: 1500, store: false
    } : {
      systemInstruction: { parts: [{ text: instructions }] },
      contents: recent.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 1500 }
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${provider} request failed (${res.status})`);
  const answer = openai ? data.output?.flatMap(item => item.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('') :
    data.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text || '').join('');
  if (!answer?.trim()) throw new Error('AI returned no answer');
  return answer.slice(0, 20000);
}
