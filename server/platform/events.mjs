// A small publish/subscribe hub for the authenticated /events WebSocket.
// Unlike the single-owner screen socket, several phone views may listen at
// once (task list, a chat, a terminal). Only paired sessions are admitted.
export class EventHub {
  constructor() {
    this.clients = new Set();
    this.handlers = new Map();
  }
  on(op, handler) {
    this.handlers.set(op, handler);
  }
  add(client) {
    // client: { ws, token, topics:Set, send(obj) }
    this.clients.add(client);
    return () => this.clients.delete(client);
  }
  publish(topic, message) {
    const payload = JSON.stringify({ topic, ...message });
    for (const client of this.clients) {
      if (!client.topics.has(topic) && !client.topics.has("*")) continue;
      if (client.ws.readyState !== 1) continue;
      // Protect the server from a stalled phone: a client that cannot keep up
      // is closed and reconnects; it then re-reads state from the REST API.
      if (client.ws.bufferedAmount > 8 * 1024 * 1024) {
        client.ws.close(4009, "Too slow");
        continue;
      }
      client.ws.send(payload);
    }
  }
  subscribers(topic) {
    let count = 0;
    for (const client of this.clients) if (client.topics.has(topic)) count++;
    return count;
  }
  async dispatch(client, message) {
    const handler = this.handlers.get(message.op);
    if (!handler) throw new Error("Unsupported event request.");
    return handler(client, message);
  }
}
