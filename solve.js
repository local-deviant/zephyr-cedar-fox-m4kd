// A fast reader for broken CSV files, written to return exactly what
// csv-reader 1.0.0 returns for the same input: {columns, rows, errors}.
//
// The reference reads one character at a time and grows every field a
// character at a time. This reader instead jumps from delimiter to
// delimiter: a whole clean record is cut out with one slice and split,
// a quoted field is found with indexOf, and only the rare broken pieces
// (a stray CR, junk after a closing quote, a quote that never closes)
// fall back to a careful field-by-field walk that mirrors the reference.
//
// Pure: no clock, no randomness, no locale, nothing kept between calls.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The answer csv-reader 1.0.0 gives for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  // A U+FEFF at the very start is dropped.
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null for the header). Field errors report these, not the line
  // the field happens to end on.
  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at pos, appending onto `head` (a
  // string, or null when nothing is kept yet) and `parts` (kept slices,
  // only made when a stray CR cuts the field in two). Returns the field
  // and how it ended. A CR not followed by LF is dropped (stray_cr).
  const DELIM = /[,\r\n]/g;
  function readUnquoted(head, parts) {
    let start = pos;
    let added = 0;
    for (;;) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      // The nearest delimiter wins; null means "not found".
      let end = -1;
      let kind = END;
      if (m !== null) {
        end = m.index;
        const ch = m[0];
        kind = ch === ',' ? COMMA : ch === '\n' ? LINE_BREAK : -1; // a CR: decide below
      }
      if (end === -1) {
        // No delimiter left: the rest of the text is the field.
        if (pos < len) {
          added += len - start;
          if (parts !== null) parts.push(text.slice(start, len));
          else head = head === null ? text.slice(start, len) : head + text.slice(start, len);
        }
        pos = len;
        const value = parts !== null ? parts.join('') : head === null ? '' : head;
        return { value, ended: END, added };
      }
      if (kind === -1) {
        // A CR: a CRLF ends the field, a lone CR is dropped (stray_cr).
        if (text.charCodeAt(end + 1) === 10) {
          added += end - start;
          if (parts !== null) parts.push(text.slice(start, end));
          else head = head === null ? text.slice(start, end) : head + text.slice(start, end);
          pos = end + 2;
          line += 1;
          const value = parts !== null ? parts.join('') : head === null ? '' : head;
          return { value, ended: LINE_BREAK, added };
        }
        pushError('stray_cr');
        added += end - start;
        if (parts === null) { parts = head === null ? [] : [head]; head = null; }
        parts.push(text.slice(start, end));
        pos = end + 1;
        start = end + 1;
        continue;
      }
      added += end - start;
      if (parts !== null) parts.push(text.slice(start, end));
      else head = head === null ? text.slice(start, end) : head + text.slice(start, end);
      if (kind === COMMA) {
        pos = end + 1;
        const value = parts !== null ? parts.join('') : head === null ? '' : head;
        return { value, ended: COMMA, added };
      }
      pos = end + 1;
      line += 1;
      const value = parts !== null ? parts.join('') : head === null ? '' : head;
      return { value, ended: LINE_BREAK, added };
    }
  }

  // Appends text[from..to) onto the quoted field's kept pieces, reading
  // each CRLF or lone CR inside it as one LF. `kept` is [head, parts]
  // shared with the caller: head a string (or null), parts an array or
  // null. Returns the updated pair through the array.
  function appendQuotedSpan(kept, from, to) {
    let head = kept[0];
    let parts = kept[1];
    let p = from;
    for (;;) {
      const ri = text.indexOf('\r', p);
      const ni = text.indexOf('\n', p);
      let br = -1;
      if (ri !== -1 && ri < to) br = ri;
      if (ni !== -1 && ni < to && (br === -1 || ni < br)) br = ni;
      if (br === -1) {
        if (p < to) {
          if (parts !== null) parts.push(text.slice(p, to));
          else head = head === null ? text.slice(p, to) : head + text.slice(p, to);
        }
        break;
      }
      if (p < br) {
        if (parts !== null) parts.push(text.slice(p, br));
        else head = head === null ? text.slice(p, br) : head + text.slice(p, br);
      }
      if (parts === null) { parts = head === null ? [] : [head]; head = null; }
      parts.push('\n');
      line += 1;
      p = br + 1;
      if (text.charCodeAt(br) === 13 && text.charCodeAt(p) === 10) p += 1;
    }
    kept[0] = head;
    kept[1] = parts;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const kept = [null, null];
    pos += 1;
    let seg = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as an unquoted field.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return readUnquoted('"', null);
      }
      appendQuotedSpan(kept, seg, q);
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote inside the field.
        const parts = kept[1];
        if (parts !== null) parts.push('"');
        else kept[0] = kept[0] === null ? '"' : kept[0] + '"';
        pos = q + 2;
        seg = q + 2;
        continue;
      }
      pos = q + 1;
      break;
    }
    const value = kept[1] !== null ? kept[1].join('') : kept[0] === null ? '' : kept[0];
    if (pos >= len) return { value, ended: END };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value, null);
    if (junk.added > 0) pushError('quote_junk');
    return junk;
  }

  // A record's fields, read one field at a time: the slow road, taken
  // only when the record holds a quote or a stray CR.
  function readRecordSlow() {
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted(null, null);
      fields.push(field.value);
    } while (field.ended === COMMA);
    return { fields, quoted };
  }

  while (pos < len) {
    // A whole clean record at once: find its line break, and take it when
    // the line holds no quote and no stray CR (a trailing CR is its CRLF).
    const nl = text.indexOf('\n', pos);
    let end = nl === -1 ? len : nl;
    if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end -= 1;
    const qi = text.indexOf('"', pos);
    const hasQuote = qi !== -1 && qi < end;
    const ri = text.indexOf('\r', pos);
    const hasStrayCr = ri !== -1 && ri < end;
    if (!hasQuote && !hasStrayCr) {
      // A line left with no characters is no record.
      if (end === pos) {
        pos = nl === -1 ? len : nl + 1;
        line += 1;
        continue;
      }
      recordLine = line;
      recordRow = header && columns === null ? null : rows.length;
      const fields = [];
      let fs = pos;
      for (;;) {
        const cc = text.indexOf(',', fs);
        if (cc === -1 || cc >= end) { fields.push(text.slice(fs, end)); break; }
        fields.push(text.slice(fs, cc));
        fs = cc + 1;
      }
      pos = nl === -1 ? len : nl + 1;
      line += 1;
      if (width < 0) width = fields.length;
      if (header && columns === null) {
        columns = fields;
        continue;
      }
      if (fields.length < width) {
        errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
        while (fields.length < width) fields.push('');
      } else if (fields.length > width) {
        errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
      }
      rows.push(fields);
      continue;
    }

    // Lines with no characters are no records: a blank line, or one left
    // blank after its CRLF. (A line of stray CRs alone reaches the slow
    // road instead, so its stray_cr errors are kept.)
    if (end === pos) {
      pos = nl === -1 ? len : nl + 1;
      line += 1;
      continue;
    }
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const { fields, quoted } = readRecordSlow();
    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
