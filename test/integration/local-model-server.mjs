import fs from "node:fs";
import http from "node:http";

const requestLog = "/tmp/codex-model-requests.jsonl";
const requests = fs.existsSync(requestLog)
  ? fs.readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean)
  : [];
const server = http.createServer(async (request, response) => {
  if (request.url?.endsWith("/models")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "ci-model", object: "model", owned_by: "ci" }],
      }),
    );
    return;
  }
  if (!request.url?.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push(body);
  fs.appendFileSync(requestLog, `${body}\n`);
  const text = `CI assistant response ${requests.length}`;
  const toolCall = requests.length === 3;
  const item = toolCall
    ? {
        id: `call-${requests.length}`,
        type: "function_call",
        call_id: `call-${requests.length}`,
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "pwd", workdir: "/workspace" }),
        status: "completed",
      }
    : {
        id: `message-${requests.length}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
  const result = {
    id: `response-${requests.length}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "ci-model",
    output: [item],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
  const events = [
    [
      "response.created",
      { response: { ...result, status: "in_progress", output: [] } },
    ],
    [
      "response.output_item.added",
      {
        output_index: 0,
        item: toolCall
          ? { ...item, status: "in_progress", arguments: "" }
          : { ...item, status: "in_progress", content: [] },
      },
    ],
    ...(toolCall
      ? [
          [
            "response.function_call_arguments.delta",
            { item_id: item.id, output_index: 0, delta: item.arguments },
          ],
          [
            "response.function_call_arguments.done",
            { item_id: item.id, output_index: 0, arguments: item.arguments },
          ],
        ]
      : [
          [
            "response.content_part.added",
            {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            },
          ],
          [
            "response.output_text.delta",
            {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: text,
            },
          ],
          [
            "response.output_text.done",
            { item_id: item.id, output_index: 0, content_index: 0, text },
          ],
          [
            "response.content_part.done",
            {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              part: item.content[0],
            },
          ],
        ]),
    ["response.output_item.done", { output_index: 0, item }],
    ["response.completed", { response: result }],
  ];
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  for (const [type, data] of events)
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
    );
  response.end();
});
server.listen(35711, "127.0.0.1");
