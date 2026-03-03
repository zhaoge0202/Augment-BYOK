#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { ensureMarker, replaceOnceRegex } = require("../lib/patch");

const MARKER = "__augment_byok_tasklist_add_tasks_errors_patched_v1";

function patchTasklistAddTasksErrors(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
  const original = fs.readFileSync(filePath, "utf8");
  if (original.includes(MARKER)) return { changed: false, reason: "already_patched" };

  let next = original;

  // Upstream add_tasks swallows per-task creation errors inside handleBatchCreation and returns
  // "Created: 0, Updated: 0, Deleted: 0" with no error details.
  // Patch: if any tasks fail, append failure summary; if all fail, return isError=true with details.
  //
  // 策略：用动态 capture group 匹配尾部的 formatBulkUpdateResponse / diff / textResult / errorResult
  //       不再硬编码 V0/s1、Qk/SF、xr/hr、it/et 等 minified 名。
  next = replaceOnceRegex(
    next,
    /async handleBatchCreation\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{[\s\S]*?let\s+([A-Za-z_$][\w$]*)=\[\];for\(let[\s\S]*?let\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.formatBulkUpdateResponse\(([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\);return\{\.\.\.([A-Za-z_$][\w$]*)\(\4\),plan:\8\}\}/g,
    (m) => {
      const resultsVar = m[3];
      const textVar = m[4];
      const formatter = m[5];
      const diffFn = m[6];
      const beforeVar = m[7];
      const afterVar = m[8];
      const textResFn = m[9];

      if (!resultsVar || !textVar || !formatter || !diffFn || !beforeVar || !afterVar || !textResFn) {
        throw new Error("tasklist add_tasks errors: capture missing");
      }

      // Find the error result function (et/it) by looking for `return XX("No root task found.")` in method body
      const errFnMatch = m[0].match(/return\s+([A-Za-z_$][\w$]*)\("No root task found\."\)/);
      if (!errFnMatch) throw new Error("tasklist add_tasks errors: error function not found");
      const errFn = errFnMatch[1];

      const oldTail = `let ${textVar}=${formatter}.formatBulkUpdateResponse(${diffFn}(${beforeVar},${afterVar}));return{...${textResFn}(${textVar}),plan:${afterVar}}`;
      const insertion =
        `let __byok_failed=${resultsVar}.filter(t=>t&&t.success===!1);` +
        `if(__byok_failed.length){` +
        `let __byok_lines=__byok_failed.slice(0,10).map(t=>"- "+String(t.taskName)+": "+String(t.error||"unknown")).join("\\n");` +
        `let __byok_more=__byok_failed.length>10?"\\n… ("+String(__byok_failed.length-10)+" more)":"";
` +
        `let __byok_msg="\\n\\nTask creation failures ("+String(__byok_failed.length)+"/"+String(${resultsVar}.length)+"):\\n"+__byok_lines+__byok_more;` +
        `if(__byok_failed.length===${resultsVar}.length)return{...${errFn}("Failed to add task(s)."+__byok_msg),plan:${afterVar}};` +
        `${textVar}+=__byok_msg;` +
        `}`;

      const newTail = `let ${textVar}=${formatter}.formatBulkUpdateResponse(${diffFn}(${beforeVar},${afterVar}));${insertion}return{...${textResFn}(${textVar}),plan:${afterVar}}`;
      if (!m[0].includes(oldTail)) throw new Error("tasklist add_tasks errors: tail not found (upstream may have changed)");
      return m[0].replace(oldTail, newTail);
    },
    "tasklist add_tasks errors: handleBatchCreation"
  );

  next = ensureMarker(next, MARKER);
  fs.writeFileSync(filePath, next, "utf8");
  return { changed: true, reason: "patched" };
}

module.exports = { patchTasklistAddTasksErrors };

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchTasklistAddTasksErrors(filePath);
}
