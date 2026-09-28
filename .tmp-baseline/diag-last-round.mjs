import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("D:/myCode/PDFMuse/data/pdfmuse.db", { readOnly: true });
const runId = "abbd7071-a8cc-4f6f-a579-f22b0ac1240b";

const reader = db.prepare("SELECT evidence_json, focus_json FROM agent_messages WHERE run_id = ? AND role = 'reader'").get(runId);
console.log("READER evidence:", reader.evidence_json, "focus:", reader.focus_json);

const answer = db.prepare("SELECT evidence_json FROM agent_messages WHERE run_id = ? AND role = 'assistant'").get(runId);
console.log("ANSWER evidence_json:", answer.evidence_json);

const search = db.prepare("SELECT result_text FROM agent_tool_calls WHERE run_id = ? AND seq = 2").get(runId);
console.log("\nsearch_book 完整结果:");
console.log(search.result_text);

const prevAnswer = db.prepare("SELECT evidence_json FROM agent_messages WHERE run_id = 'f228c645-afee-4c30-904f-aef370dc8822' AND role = 'assistant'").get();
console.log("\n上一轮 ANSWER evidence_json:", prevAnswer.evidence_json);
