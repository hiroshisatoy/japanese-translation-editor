'use strict';

/**
 * WordPress / gettext の PO・POT を、表示と検索に使うエントリ配列へ変換する。
 * ファイルが数十万行でもメインスレッドを占有し続けないよう、一定行ごとに制御を返す。
 */
(function attachPoParser() {
  /**
   * @return {Promise<void>}
   */
  function yieldToMain() {
    const schedulerApi = globalThis.scheduler;
    if (schedulerApi && typeof schedulerApi.yield === 'function') {
      return schedulerApi.yield();
    }
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  /**
   * 引用符で囲まれた PO の文字列を取り出し、エスケープを戻す。
   * @param {string} segment
   * @return {string}
   */
  function unquote(segment) {
    const start = segment.indexOf('"');
    if (start === -1) {
      return '';
    }
    let out = '';
    for (let i = start + 1; i < segment.length; i++) {
      const char = segment[i];
      if (char === '"') {
        return out;
      }
      if (char !== '\\') {
        out += char;
        continue;
      }
      const next = segment[++i];
      if (next === 'n') {
        out += '\n';
      } else if (next === 't') {
        out += '\t';
      } else if (next === 'r') {
        out += '\r';
      } else if (next === '"') {
        out += '"';
      } else if (next === '\\') {
        out += '\\';
      } else if (next >= '0' && next <= '7') {
        let octal = next;
        for (let k = 0; k < 2; k++) {
          const digit = segment[i + 1];
          if (digit >= '0' && digit <= '7') {
            octal += digit;
            i++;
          } else {
            break;
          }
        }
        out += String.fromCharCode(Number.parseInt(octal, 8));
      } else if (next !== undefined) {
        out += next;
      }
    }
    return out;
  }

  /**
   * @param {string} current
   * @param {string} extra
   * @return {string}
   */
  function addComment(current, extra) {
    if (!extra) {
      return current;
    }
    return current ? `${current}\n${extra}` : extra;
  }

  /**
   * @param {string} raw
   * @return {Object<string, string>}
   */
  function headerMap(raw) {
    const map = Object.create(null);
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const index = line.indexOf(':');
      if (index > 0) {
        map[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
    }
    return map;
  }

  /**
   * @param {string} filename
   * @return {Object}
   */
  function blankEntry(filename) {
    return {
      file: filename,
      context: '',
      msgid: null,
      msgidPlural: '',
      msgstr: [],
      flags: [],
      references: [],
      extracted: '',
      translator: '',
      previous: '',
      status: 'untranslated',
      slots: 1,
      blob: '',
      cuts: [0, 0, 0],
    };
  }

  /**
   * @param {Object} entry
   * @param {number} index
   * @param {string} value
   * @param {boolean} append
   */
  function writeMsgstr(entry, index, value, append) {
    while (entry.msgstr.length <= index) {
      entry.msgstr.push('');
    }
    entry.msgstr[index] = append ? entry.msgstr[index] + value : value;
  }

  /**
   * @param {Object} entry
   * @param {string} mode
   * @param {string} value
   * @param {boolean} append
   */
  function writeField(entry, mode, value, append) {
    if (mode === 'msgid') {
      entry.msgid = append ? (entry.msgid || '') + value : value;
    } else if (mode === 'msgid_plural') {
      entry.msgidPlural = append ? entry.msgidPlural + value : value;
    } else if (mode === 'msgctxt') {
      entry.context = append ? entry.context + value : value;
    } else if (mode === 'prev_msgid') {
      entry.previous = append ? entry.previous + value : value;
    } else if (mode === 'msgstr') {
      writeMsgstr(entry, 0, value, append);
    } else if (mode && mode.indexOf('msgstr[') === 0) {
      const index = Number(mode.slice(7, -1));
      writeMsgstr(entry, index, value, append);
    }
  }

  /**
   * @param {string} line
   * @return {?[string, string]}
   */
  function matchKeyword(line) {
    if (line.startsWith('msgid_plural ') || line.startsWith('msgid_plural\t')) {
      return ['msgid_plural', line.slice(12).trimStart()];
    }
    if (line.startsWith('msgid ') || line.startsWith('msgid\t')) {
      return ['msgid', line.slice(5).trimStart()];
    }
    if (line.startsWith('msgstr[')) {
      const bracket = line.indexOf(']');
      if (bracket > 7) {
        return [line.slice(0, bracket + 1), line.slice(bracket + 1).trimStart()];
      }
    }
    if (line.startsWith('msgstr ') || line.startsWith('msgstr\t')) {
      return ['msgstr', line.slice(6).trimStart()];
    }
    if (line.startsWith('msgctxt ') || line.startsWith('msgctxt\t')) {
      return ['msgctxt', line.slice(7).trimStart()];
    }
    return null;
  }

  /**
   * @param {Object} entry
   * @param {number} nplurals
   */
  function finalize(entry, nplurals) {
    const slots = entry.msgidPlural ? (nplurals || Math.max(entry.msgstr.length, 2)) : 1;
    let filled = 0;
    for (let i = 0; i < slots; i++) {
      if (entry.msgstr[i]) {
        filled++;
      }
    }
    if (entry.flags.indexOf('fuzzy') !== -1) {
      entry.status = 'fuzzy';
    } else if (filled === 0) {
      entry.status = 'untranslated';
    } else if (filled < slots) {
      entry.status = 'partial';
    } else {
      entry.status = 'translated';
    }
    entry.slots = slots;

    const original = `${entry.msgid}\n${entry.msgidPlural}\n${entry.previous}`.toLowerCase();
    const translation = entry.msgstr.join('\n').toLowerCase();
    const context = entry.context.toLowerCase();
    const ref = `${entry.references.join(' ')}\n${entry.extracted}\n${entry.translator}\n${entry.file}`.toLowerCase();
    entry.blob = `${original}\0${translation}\0${context}\0${ref}`;
    const originalEnd = original.length;
    const translationEnd = originalEnd + 1 + translation.length;
    const contextEnd = translationEnd + 1 + context.length;
    entry.cuts = [originalEnd, translationEnd, contextEnd];
  }

  /**
   * @param {string} text
   * @param {string} filename
   * @param {{onProgress?: function(number): void, isCancelled?: function(): boolean}=} hooks
   * @return {Promise<?{entries: Object[], headers: Object<string, string>, obsolete: number, filename: string}>}
   */
  async function parsePo(text, filename, hooks) {
    const onProgress = hooks && hooks.onProgress;
    const isCancelled = (hooks && hooks.isCancelled) || (() => false);
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }

    const entries = [];
    let headerRaw = '';
    let obsolete = 0;
    let entry = blankEntry(filename);
    let mode = null;
    let skippingObsolete = false;
    let cursor = 0;
    let lineIndex = 0;
    const total = text.length || 1;

    /**
     * 空の msgid はカタログのヘッダなので一覧には出さない。
     */
    function flush() {
      if (entry.msgid === null) {
        entry = blankEntry(filename);
        mode = null;
        return;
      }
      if (entry.msgid === '') {
        if (!headerRaw) {
          headerRaw = entry.msgstr[0] || '';
        }
      } else {
        entries.push(entry);
      }
      entry = blankEntry(filename);
      mode = null;
    }

    function consume(line) {
      if (line === '') {
        if (skippingObsolete) {
          skippingObsolete = false;
          mode = null;
          return;
        }
        flush();
        return;
      }
      if (skippingObsolete) {
        return;
      }
      if (line.startsWith('#~')) {
        skippingObsolete = true;
        if (line.indexOf('msgid ') !== -1) {
          obsolete++;
        }
        return;
      }
      if (line.startsWith('#')) {
        if (line.startsWith('#|')) {
          const rest = line.slice(2).trim();
          if (rest.startsWith('"') && mode === 'prev_msgid') {
            entry.previous += unquote(rest);
          } else if (rest.startsWith('msgid ')) {
            mode = 'prev_msgid';
            entry.previous = unquote(rest.slice(6));
          }
          return;
        }
        if (line.startsWith('#,')) {
          const flags = line.slice(2).split(',');
          for (let i = 0; i < flags.length; i++) {
            const flag = flags[i].trim();
            if (flag) {
              entry.flags.push(flag);
            }
          }
          return;
        }
        if (line.startsWith('#:')) {
          const refs = line.slice(2).trim().split(/\s+/);
          for (let i = 0; i < refs.length; i++) {
            if (refs[i]) {
              entry.references.push(refs[i]);
            }
          }
          return;
        }
        if (line.startsWith('#.')) {
          entry.extracted = addComment(entry.extracted, line.slice(2).trim());
          return;
        }
        entry.translator = addComment(entry.translator, line.slice(1).trim());
        return;
      }
      if (line.startsWith('"') && mode) {
        writeField(entry, mode, unquote(line), true);
        return;
      }
      const keyword = matchKeyword(line);
      if (!keyword) {
        return;
      }
      mode = keyword[0];
      writeField(entry, mode, unquote(keyword[1]), false);
    }

    while (cursor <= text.length) {
      let next = text.indexOf('\n', cursor);
      if (next === -1) {
        next = text.length;
      }
      let line = text.slice(cursor, next);
      if (line.length && line.charCodeAt(line.length - 1) === 13) {
        line = line.slice(0, -1);
      }
      consume(line);
      if (next >= text.length) {
        break;
      }
      cursor = next + 1;
      lineIndex++;
      if ((lineIndex & 8191) === 0) {
        if (isCancelled()) {
          return null;
        }
        if (onProgress) {
          onProgress(cursor / total);
        }
        await yieldToMain();
      }
    }
    if (!skippingObsolete) {
      flush();
    }

    const headers = headerMap(headerRaw);
    const pluralMatch = (headers['Plural-Forms'] || '').match(/nplurals\s*=\s*(\d+)/);
    const nplurals = pluralMatch ? Number(pluralMatch[1]) : 0;
    for (let i = 0; i < entries.length; i++) {
      finalize(entries[i], nplurals);
      if ((i & 2047) === 2047) {
        if (isCancelled()) {
          return null;
        }
        await yieldToMain();
      }
    }
    if (onProgress) {
      onProgress(1);
    }
    return {entries, headers, obsolete, filename};
  }

  globalThis.PoParser = {parsePo};
})();
