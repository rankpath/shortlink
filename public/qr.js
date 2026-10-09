/* QR encoder — dependency-free QR Code generator (ISO/IEC 18004).
   Byte mode, versions 1–40, error-correction levels L/M/Q/H, automatic mask selection.
   Exposes window.QRGen = { encode, toSvg, drawCanvas }. */
(function (global) {
  'use strict';

  var ECL = { L: { ordinal: 0, formatBits: 1 }, M: { ordinal: 1, formatBits: 0 }, Q: { ordinal: 2, formatBits: 3 }, H: { ordinal: 3, formatBits: 2 } };

  // Index = version (0 unused). Rows = L, M, Q, H.
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  function getNumRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function getNumDataCodewords(ver, ecl) {
    return Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
  }
  function gfMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ result.shift();
      result.push(0);
      divisor.forEach(function (coef, i) { result[i] ^= gfMultiply(coef, factor); });
    });
    return result;
  }
  function toUtf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') return Array.prototype.slice.call(new TextEncoder().encode(text));
    var encoded = unescape(encodeURIComponent(text)), out = [];
    for (var i = 0; i < encoded.length; i++) out.push(encoded.charCodeAt(i));
    return out;
  }

  function encode(text, eclName, forcedMask) {
    var ecl = ECL[eclName] || ECL.M;
    var mask = typeof forcedMask === 'number' ? forcedMask : -1;
    var bytes = toUtf8Bytes(String(text));

    // Pick the smallest version that fits (byte mode).
    var version = -1;
    for (var v = 1; v <= 40; v++) {
      var need = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
      if (need <= getNumDataCodewords(v, ecl) * 8) { version = v; break; }
    }
    if (version < 0) throw new Error('Text is too long for a QR code');

    var bits = [];
    function appendBits(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    appendBits(4, 4);
    appendBits(bytes.length, version <= 9 ? 8 : 16);
    bytes.forEach(function (b) { appendBits(b, 8); });
    var capacityBits = getNumDataCodewords(version, ecl) * 8;
    appendBits(0, Math.min(4, capacityBits - bits.length));
    appendBits(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8);
    var dataCodewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      dataCodewords.push(byte);
    }

    var size = version * 4 + 17;
    var modules = [], isFunction = [];
    for (var y = 0; y < size; y++) { modules.push(new Array(size).fill(false)); isFunction.push(new Array(size).fill(false)); }
    function setFunctionModule(x, y, isDark) { modules[y][x] = isDark; isFunction[y][x] = true; }
    function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

    function drawFinderPattern(x, y) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
    function drawAlignmentPattern(x, y) {
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    function alignmentPositions() {
      if (version === 1) return [];
      var numAlign = Math.floor(version / 7) + 2;
      var step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
      var result = [6];
      for (var pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
      return result;
    }
    function drawFormatBits(msk) {
      var data = ecl.formatBits << 3 | msk, rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fbits = (data << 10 | rem) ^ 0x5412;
      for (i = 0; i <= 5; i++) setFunctionModule(8, i, getBit(fbits, i));
      setFunctionModule(8, 7, getBit(fbits, 6));
      setFunctionModule(8, 8, getBit(fbits, 7));
      setFunctionModule(7, 8, getBit(fbits, 8));
      for (i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getBit(fbits, i));
      for (i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, getBit(fbits, i));
      for (i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, getBit(fbits, i));
      setFunctionModule(8, size - 8, true);
    }
    function drawVersion() {
      if (version < 7) return;
      var rem = version;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = version << 12 | rem;
      for (i = 0; i < 18; i++) {
        var color = getBit(vbits, i), a = size - 11 + i % 3, b = Math.floor(i / 3);
        setFunctionModule(a, b, color);
        setFunctionModule(b, a, color);
      }
    }
    function drawFunctionPatterns() {
      for (var i = 0; i < size; i++) { setFunctionModule(6, i, i % 2 === 0); setFunctionModule(i, 6, i % 2 === 0); }
      drawFinderPattern(3, 3); drawFinderPattern(size - 4, 3); drawFinderPattern(3, size - 4);
      var align = alignmentPositions(), n = align.length;
      for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
        if (!((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0))) drawAlignmentPattern(align[a], align[b]);
      }
      drawFormatBits(0);
      drawVersion();
    }
    function addEccAndInterleave(data) {
      var numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][version];
      var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][version];
      var rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
      var numShortBlocks = numBlocks - rawCodewords % numBlocks;
      var shortBlockLen = Math.floor(rawCodewords / numBlocks);
      var blocks = [], divisor = rsDivisor(blockEccLen);
      for (var i = 0, k = 0; i < numBlocks; i++) {
        var dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
        k += dat.length;
        var ecc = rsRemainder(dat, divisor);
        if (i < numShortBlocks) dat.push(0);
        blocks.push(dat.concat(ecc));
      }
      var result = [];
      for (i = 0; i < blocks[0].length; i++) {
        blocks.forEach(function (block, j) { if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]); });
      }
      return result;
    }
    function drawCodewords(data) {
      var i = 0;
      for (var right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (var vert = 0; vert < size; vert++) {
          for (var j = 0; j < 2; j++) {
            var x = right - j, upward = ((right + 1) & 2) === 0, yy = upward ? size - 1 - vert : vert;
            if (!isFunction[yy][x] && i < data.length * 8) { modules[yy][x] = getBit(data[i >>> 3], 7 - (i & 7)); i++; }
          }
        }
      }
    }
    function applyMask(msk) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
        var invert;
        switch (msk) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = x * y % 2 + x * y % 3 === 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
          default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
        }
        if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x];
      }
    }
    function finderPenaltyCountPatterns(h) {
      var n = h[1];
      var core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
      return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
    }
    function finderPenaltyAddHistory(runLength, h) {
      if (h[0] === 0) runLength += size;
      h.pop(); h.unshift(runLength);
    }
    function finderPenaltyTerminateAndCount(runColor, runLength, h) {
      if (runColor) { finderPenaltyAddHistory(runLength, h); runLength = 0; }
      runLength += size;
      finderPenaltyAddHistory(runLength, h);
      return finderPenaltyCountPatterns(h);
    }
    function penaltyScore() {
      var result = 0, x, y, runColor, runLen, hist, dark = 0;
      for (y = 0; y < size; y++) {
        runColor = false; runLen = 0; hist = [0, 0, 0, 0, 0, 0, 0];
        for (x = 0; x < size; x++) {
          if (modules[y][x] === runColor) { runLen++; if (runLen === 5) result += PENALTY_N1; else if (runLen > 5) result++; }
          else { finderPenaltyAddHistory(runLen, hist); if (!runColor) result += finderPenaltyCountPatterns(hist) * PENALTY_N3; runColor = modules[y][x]; runLen = 1; }
        }
        result += finderPenaltyTerminateAndCount(runColor, runLen, hist) * PENALTY_N3;
      }
      for (x = 0; x < size; x++) {
        runColor = false; runLen = 0; hist = [0, 0, 0, 0, 0, 0, 0];
        for (y = 0; y < size; y++) {
          if (modules[y][x] === runColor) { runLen++; if (runLen === 5) result += PENALTY_N1; else if (runLen > 5) result++; }
          else { finderPenaltyAddHistory(runLen, hist); if (!runColor) result += finderPenaltyCountPatterns(hist) * PENALTY_N3; runColor = modules[y][x]; runLen = 1; }
        }
        result += finderPenaltyTerminateAndCount(runColor, runLen, hist) * PENALTY_N3;
      }
      for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
        var c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += PENALTY_N2;
      }
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (modules[y][x]) dark++;
      var total = size * size;
      result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * PENALTY_N4;
      return result;
    }

    drawFunctionPatterns();
    drawCodewords(addEccAndInterleave(dataCodewords));
    if (mask === -1) {
      var minPenalty = Infinity;
      for (var m = 0; m < 8; m++) {
        applyMask(m); drawFormatBits(m);
        var penalty = penaltyScore();
        if (penalty < minPenalty) { mask = m; minPenalty = penalty; }
        applyMask(m);
      }
    }
    applyMask(mask);
    drawFormatBits(mask);
    return { size: size, version: version, mask: mask, ecl: eclName || 'M', modules: modules };
  }

  function toSvg(qr, options) {
    var o = options || {}, margin = o.margin == null ? 4 : o.margin, fg = o.fg || '#0f172a', bg = o.bg || '#ffffff';
    var total = qr.size + margin * 2, parts = [];
    for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++) if (qr.modules[y][x]) parts.push('M' + (x + margin) + ' ' + (y + margin) + 'h1v1h-1z');
    var px = o.size || total * 8;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + total + ' ' + total + '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="' + bg + '"/><path d="' + parts.join('') + '" fill="' + fg + '"/></svg>';
  }
  function drawCanvas(qr, canvas, options) {
    var o = options || {}, margin = o.margin == null ? 4 : o.margin, px = o.size || 256;
    var total = qr.size + margin * 2, scale = px / total, ctx = canvas.getContext('2d');
    canvas.width = px; canvas.height = px;
    ctx.fillStyle = o.bg || '#ffffff'; ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = o.fg || '#0f172a';
    for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) ctx.fillRect(Math.floor((x + margin) * scale), Math.floor((y + margin) * scale), Math.ceil(scale), Math.ceil(scale));
    }
    return canvas;
  }

  global.QRGen = { encode: encode, toSvg: toSvg, drawCanvas: drawCanvas };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
