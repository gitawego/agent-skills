// A YAML subset: indentation, block and flow collections, scalars.
// It covers the shapes this skill writes and refuses anything else, loudly.
import { UserError } from "./util.mjs";

const KEY = /^([A-Za-z0-9_.][A-Za-z0-9_.-]*):(\s|$)/;

function fail(message, line) {
  throw new UserError(line ? `${message} (near "${line.text}")` : message);
}

function splitKey(text) {
  const m = text.match(KEY);
  if (!m) return null;
  return { key: m[1], rest: text.slice(m[0].length).trim() };
}

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text;
}

function lines(text) {
  const out = [];
  text.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    if (raw.trimStart().startsWith("#")) return;
    const body = stripComment(raw);
    if (!body.trim()) return;
    const indent = body.length - body.trimStart().length;
    if (body.slice(indent).startsWith("\t")) fail("Indent with spaces, not tabs", { text: raw });
    out.push({ indent, text: body.trim(), raw, index });
  });
  return out;
}

function splitTopLevel(text, separator = ",") {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function unquote(text) {
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

function splitFlowKey(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ":") {
      const rawKey = text.slice(0, i).trim();
      return { key: unquote(rawKey) ?? rawKey, rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseFlow(text) {
  const body = text.trim();
  if (body.startsWith("[")) {
    if (!body.endsWith("]")) fail("Unterminated flow sequence");
    return splitTopLevel(body.slice(1, -1)).map((item) => parseValue(item));
  }
  if (body.startsWith("{")) {
    if (!body.endsWith("}")) fail("Unterminated flow mapping");
    const obj = {};
    for (const item of splitTopLevel(body.slice(1, -1))) {
      const entry = splitFlowKey(item);
      if (!entry) fail(`Expected "key: value" in flow mapping, got "${item}"`);
      obj[entry.key] = entry.rest === "" ? null : parseValue(entry.rest);
    }
    return obj;
  }
  fail(`Not a flow collection: ${text}`);
}

function parseValue(text) {
  const body = text.trim();
  if (body === "") return null;
  if (body.startsWith("[") || body.startsWith("{")) return parseFlow(body);
  const q = unquote(body);
  if (q !== null) return q;
  if (body === "true") return true;
  if (body === "false") return false;
  if (body === "null" || body === "~") return null;
  if (/^-?\d+$/.test(body)) return Number(body);
  if (/^-?\d+\.\d+$/.test(body)) return Number(body);
  return body;
}

function isMapEntry(text) {
  return splitKey(text) !== null;
}

function parseMap(rows, i, indent, into = {}) {
  while (i < rows.length) {
    const row = rows[i];
    if (row.indent < indent) break;
    if (row.indent > indent) fail("Unexpected indentation", row);
    if (row.text.startsWith("- ")) break;
    const entry = splitKey(row.text);
    if (!entry) fail("Expected \"key: value\"", row);
    if (entry.rest === "") {
      const next = rows[i + 1];
      if (next && next.indent > indent) {
        const [value, nextIndex] = parseNode(rows, i + 1, next.indent);
        into[entry.key] = value;
        i = nextIndex;
      } else {
        into[entry.key] = null;
        i++;
      }
    } else {
      into[entry.key] = parseValue(entry.rest);
      i++;
    }
  }
  return [into, i];
}

function parseSeq(rows, i, indent) {
  const arr = [];
  while (i < rows.length) {
    const row = rows[i];
    if (row.indent !== indent || !row.text.startsWith("-")) break;
    const rest = row.text.replace(/^-\s?/, "").trim();
    if (rest === "") {
      const next = rows[i + 1];
      if (!next || next.indent <= indent) {
        arr.push(null);
        i++;
        continue;
      }
      const [value, nextIndex] = parseNode(rows, i + 1, next.indent);
      arr.push(value);
      i = nextIndex;
      continue;
    }
    if (rest === "-" || rest.startsWith("- ")) {
      const synthetic = [...rows];
      synthetic[i] = { ...row, indent: indent + 2, text: rest };
      const [value, nextIndex] = parseSeq(synthetic, i, indent + 2);
      arr.push(value);
      i = nextIndex;
      continue;
    }
    if (isMapEntry(rest)) {
      const obj = {};
      const entry = splitKey(rest);
      if (entry.rest === "") {
        const next = rows[i + 1];
        if (next && next.indent > indent) {
          const [value, nextIndex] = parseNode(rows, i + 1, next.indent);
          obj[entry.key] = value;
          i = nextIndex;
        } else {
          obj[entry.key] = null;
          i++;
        }
      } else {
        obj[entry.key] = parseValue(entry.rest);
        i++;
      }
      if (i < rows.length && rows[i].indent > indent) {
        const [more, nextIndex] = parseMap(rows, i, rows[i].indent, obj);
        i = nextIndex;
      }
      arr.push(obj);
      continue;
    }
    arr.push(parseValue(rest));
    i++;
  }
  return [arr, i];
}


/* Literal and folded block scalars are the only YAML feature the line parser
   cannot see, because it drops blank lines before parsing. Expand them into a
   quoted scalar first so `brief: |` works in plan files and frontmatter. */
function expandBlockScalars(text) {
  const raw = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const header = /^(\s*(?:-\s+)?[A-Za-z0-9_.-]+):\s*([|>])([-+]?)\s*(?:#.*)?$/;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const match = line.match(header);
    if (!match) {
      out.push(line);
      continue;
    }
    const keyIndent = line.length - line.trimStart().length;
    const block = [];
    let j = i + 1;
    while (j < raw.length) {
      const next = raw[j];
      if (!next.trim()) {
        block.push("");
        j++;
        continue;
      }
      const indent = next.length - next.trimStart().length;
      if (indent <= keyIndent) break;
      block.push(next);
      j++;
    }
    const first = block.find((entry) => entry.trim());
    const contentIndent = first ? first.length - first.trimStart().length : keyIndent + 2;
    const content = block.map((entry) => (entry.trim() ? entry.slice(contentIndent) : ""));
    while (content.length && content[content.length - 1] === "") content.pop();
    let value;
    if (match[2] === "|") {
      value = content.join("\n");
    } else {
      value = content.reduce((acc, entry) => {
        if (entry === "") return `${acc}\n`;
        if (!acc || acc.endsWith("\n")) return `${acc}${entry.trim()}`;
        return `${acc} ${entry.trim()}`;
      }, "");
    }
    if (match[3] !== "-" && value) value += "\n";
    if (match[3] === "+" && value) value += "\n";
    out.push(`${line.slice(0, line.indexOf(":"))}: ${JSON.stringify(value)}`);
    i = j - 1;
  }
  return out.join("\n");
}

function parseNode(rows, i, indent) {
  if (!rows[i]) return [null, i];
  if (rows[i].text.startsWith("[") || rows[i].text.startsWith("{")) return [parseFlow(rows[i].text), i + 1];
  if (rows[i].text.startsWith("-")) return parseSeq(rows, i, indent);
  return parseMap(rows, i, indent);
}

export function parseYaml(text) {
  const rows = lines(expandBlockScalars(text));
  if (!rows.length) return {};
  const [value, index] = parseNode(rows, 0, rows[0].indent);
  if (index < rows.length) fail("Could not parse the rest of the document", rows[index]);
  return value;
}

const PLAIN = /^[A-Za-z0-9_./<>@+*$:=|-][A-Za-z0-9_./<>@+*$:=|\- ]*$/;

function scalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value);
  if (s === "") return '""';
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s)) return JSON.stringify(s);
  if (PLAIN.test(s) && !s.endsWith(" ")) return s;
  return JSON.stringify(s);
}

function inline(value) {
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) {
      return `[${value.map((v) => scalar(v)).join(", ")}]`;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    if (entries.every(([, v]) => v === null || typeof v !== "object")) {
      return `{ ${entries.map(([k, v]) => `${k}: ${scalar(v)}`).join(", ")} }`;
    }
    return null;
  }
  return scalar(value);
}

function emit(value, indent, out) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) {
      out.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (!entries.length) {
          out.push(`${pad}- {}`);
          continue;
        }
        const [firstKey, firstValue] = entries[0];
        const flatFirst = inline(firstValue);
        if (flatFirst && entries.length === 1) {
          out.push(`${pad}- ${firstKey}: ${flatFirst}`);
          continue;
        }
        const nested = flatFirst && (firstValue === null || typeof firstValue !== "object");
        out.push(`${pad}- ${firstKey}:${nested ? ` ${flatFirst}` : ""}`);
        if (!nested) emitNested(firstValue, indent + 4, out);
        for (const [key, value2] of entries.slice(1)) {
          const flat = inline(value2);
          if (flat) {
            out.push(`${pad}  ${key}: ${flat}`);
            continue;
          }
          out.push(`${pad}  ${key}:`);
          emitNested(value2, indent + 4, out);
        }
        continue;
      }
      out.push(`${pad}- ${scalar(item)}`);
    }
    return;
  }
  emitNested(value, indent, out, true);
}

function emitNested(value, indent, out, atRoot = false) {
  const pad = " ".repeat(indent);
  if (value === null || typeof value !== "object") {
    if (atRoot) out.push(`${pad}${scalar(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      out.push(`${pad}[]`);
      return;
    }
    const flat = inline(value);
    if (flat) out.push(`${pad}${flat}`);
    else emit(value, indent, out);
    return;
  }
  const entries = Object.entries(value);
  if (!entries.length) {
    out.push(`${pad}{}`);
    return;
  }
  for (const [key, v] of entries) {
    const flat = inline(v);
    if (v === null || typeof v !== "object") {
      out.push(`${pad}${key}: ${scalar(v)}`);
    } else if (flat) {
      out.push(`${pad}${key}: ${flat}`);
    } else {
      out.push(`${pad}${key}:`);
      emitNested(v, indent + 2, out);
    }
  }
}

export function stringifyYaml(value) {
  const out = [];
  emitNested(value, 0, out, true);
  return out.join("\n") + "\n";
}

export function splitFrontmatter(text) {
  const normalized = String(text).replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, body: normalized, hasFrontmatter: false };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: normalized, hasFrontmatter: false };
  const header = normalized.slice(4, end);
  const rest = normalized.slice(end + 4).replace(/^\n/, "");
  return { data: parseYaml(header), body: rest, hasFrontmatter: true };
}

export function joinFrontmatter(data, body) {
  return `---\n${stringifyYaml(data)}---\n\n${String(body).replace(/^\n+/, "")}`;
}

export function updateFrontmatter(text, patch) {
  const { data, body } = splitFrontmatter(text);
  return joinFrontmatter({ ...data, ...patch }, body);
}
