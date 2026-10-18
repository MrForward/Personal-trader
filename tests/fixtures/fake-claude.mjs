#!/usr/bin/env node
// Stand-in for the `claude` binary; behaviour is chosen by FAKE_CLAUDE_MODE.
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;
const mode = process.env.FAKE_CLAUDE_MODE;
if (mode === 'ok') {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: JSON.parse(process.env.FAKE_CLAUDE_OUTPUT), usage: { input_tokens: 120, output_tokens: 30 }, total_cost_usd: 0.004 }));
} else if (mode === 'limit') {
  console.log("You've hit your session limit · resets 3:45pm");
  process.exit(1);
} else if (mode === 'badjson') {
  console.log(JSON.stringify({ type: 'result', structured_output: { wrong: 1 } }));
} else if (mode === 'maxturns') {
  // Shape seen live from CLI 2.1.52 when --max-turns is too low for --json-schema.
  console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: false, num_turns: 2, usage: { input_tokens: 4, output_tokens: 52 }, total_cost_usd: 0.001 }));
} else if (mode === 'hang') {
  await new Promise((resolve) => setTimeout(resolve, 10000));
} else if (mode === 'argv') {
  console.log(JSON.stringify({ type: 'result', structured_output: { argv: process.argv.slice(2), env: Object.keys(process.env), stdin, cwd: process.cwd(), files: (await import('node:fs')).readdirSync('.') } }));
} else {
  console.error('unknown FAKE_CLAUDE_MODE');
  process.exit(2);
}
