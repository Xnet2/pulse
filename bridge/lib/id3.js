const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];

function tagLength(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const footer = buf[3] === 4 && buf[5] & 0x10 ? 10 : 0;
  return 10 + syncsafe(buf, 6) + footer;
}

function nullEnd(buf, from, wide) {
  if (!wide) return buf.indexOf(0, from);
  for (let i = from; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return i;
  return -1;
}

function decodeApic(frame) {
  const wide = frame[0] === 1 || frame[0] === 2;
  const mimeEnd = frame.indexOf(0, 1);
  if (mimeEnd < 0) return null;
  const descEnd = nullEnd(frame, mimeEnd + 2, wide);
  if (descEnd < 0) return null;
  const data = frame.subarray(descEnd + (wide ? 2 : 1));
  return data.length ? { mime: detectMime(data), data } : null;
}

function decodePic(frame) {
  const wide = frame[0] === 1 || frame[0] === 2;
  const descEnd = nullEnd(frame, 5, wide);
  if (descEnd < 0) return null;
  const data = frame.subarray(descEnd + (wide ? 2 : 1));
  return data.length ? { mime: detectMime(data), data } : null;
}

function detectMime(data) {
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  return null;
}

// Works on a truncated buffer as long as the picture frame itself is complete.
function readPicture(buf) {
  const end = Math.min(tagLength(buf), buf.length);
  if (!end) return null;
  const version = buf[3];
  if (buf[5] & 0x80 && version < 4) return null;
  let pos = 10;
  if (buf[5] & 0x40 && version >= 3) pos += (version === 4 ? syncsafe(buf, pos) : buf.readUInt32BE(pos) + 4);
  const headerSize = version === 2 ? 6 : 10;
  while (pos + headerSize <= end && buf[pos] !== 0) {
    const id = buf.toString('latin1', pos, pos + (version === 2 ? 3 : 4));
    const size = version === 2 ? buf.readUIntBE(pos + 3, 3)
      : version === 4 ? syncsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
    const start = pos + headerSize;
    if (id === 'APIC' || id === 'PIC') {
      if (start + size > buf.length) return null;
      const picture = (id === 'PIC' ? decodePic : decodeApic)(buf.subarray(start, start + size));
      if (picture && picture.mime) return picture;
    }
    pos = start + size;
  }
  return null;
}

function textFrame(id, text) {
  const body = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  return frame(id, body);
}

function frame(id, body) {
  const header = Buffer.alloc(10);
  header.write(id, 0, 'latin1');
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function pictureFrame({ mime, data }) {
  return frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from(mime, 'latin1'), Buffer.from([0, 3, 0]), data]));
}

function retag(buf, { title, artist, album, picture }) {
  const existing = picture || readPicture(buf);
  let audio = buf.subarray(tagLength(buf));
  if (audio.length > 128 && audio.toString('latin1', audio.length - 128, audio.length - 125) === 'TAG') {
    audio = audio.subarray(0, audio.length - 128);
  }
  const frames = [textFrame('TIT2', title)];
  if (artist) frames.push(textFrame('TPE1', artist));
  if (album) frames.push(textFrame('TALB', album));
  if (existing) frames.push(pictureFrame(existing));
  const body = Buffer.concat(frames);
  const n = body.length;
  const header = Buffer.from(['I'.charCodeAt(0), 'D'.charCodeAt(0), '3'.charCodeAt(0), 3, 0, 0,
    (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  return Buffer.concat([header, body, audio]);
}

module.exports = { tagLength, readPicture, retag };
