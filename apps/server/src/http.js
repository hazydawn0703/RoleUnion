export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function requireThat(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

export async function readJson(request) {
  requireThat(request.headers['content-type']?.split(';')[0] === 'application/json', 415, '请发送 JSON。');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    requireThat(size <= 256_000, 413, '提交内容过长。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 格式有误。');
  }
}

export function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
