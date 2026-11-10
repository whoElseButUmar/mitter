/** Minimal TrueType name table for parser tests, not a usable font. */
export function fontFixtureBytes({
  family = 'FiraCode Nerd Font Mono',
  familyNameId = 1,
  style = 'Regular',
  postScriptName = 'FiraCodeNFM-Reg',
  platformId = 3,
} = {}) {
  const names = [
    [0, 'Copyright fixture'],
    [0, 'Copyright fixture'],
    [0, 'Copyright second fixture'],
    [familyNameId, family],
    [2, style],
    [6, postScriptName],
  ];
  const encodedNames = names.map(([nameId, text]) => {
    let bytes;

    if (platformId === 1) {
      bytes = Buffer.from(text, 'latin1');
    } else {
      bytes = Buffer.from(text, 'utf16le').swap16();
    }

    return { nameId, bytes };
  });
  const nameTableOffset = 28;
  const stringStorageOffset = 6 + names.length * 12;
  const stringBytes = Buffer.concat(
    encodedNames.map((record) => {
      return record.bytes;
    }),
  );
  const nameTableLength = stringStorageOffset + stringBytes.length;
  const font = Buffer.alloc(nameTableOffset + nameTableLength);

  font.writeUInt32BE(0x00010000, 0);
  font.writeUInt16BE(1, 4);
  font.write('name', 12, 'ascii');
  font.writeUInt32BE(nameTableOffset, 20);
  font.writeUInt32BE(nameTableLength, 24);
  font.writeUInt16BE(names.length, nameTableOffset + 2);
  font.writeUInt16BE(stringStorageOffset, nameTableOffset + 4);

  let stringOffset = 0;

  for (const [recordIndex, record] of encodedNames.entries()) {
    const recordOffset = nameTableOffset + 6 + recordIndex * 12;

    font.writeUInt16BE(platformId, recordOffset);
    font.writeUInt16BE(1, recordOffset + 2);
    font.writeUInt16BE(0x0409, recordOffset + 4);
    font.writeUInt16BE(record.nameId, recordOffset + 6);
    font.writeUInt16BE(record.bytes.length, recordOffset + 8);
    font.writeUInt16BE(stringOffset, recordOffset + 10);
    stringOffset += record.bytes.length;
  }

  stringBytes.copy(font, nameTableOffset + stringStorageOffset);

  return font;
}
