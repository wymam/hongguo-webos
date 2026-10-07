(function () {
  // Diagnose the MEDIA_ELEMENT_ERROR: Format error.
  // Two hypotheses: (a) the proxy serves bytes the TV cannot decode (codec),
  // (b) the MP4 box layout we emit is not what the TV's demuxer expects.
  // Fetch the first bytes through the SAME url the player used and inspect the
  // box structure + codec fourcc, then ask the media stack what it supports.
  return fetch('http://127.0.0.1:7655/media/7689431795942575129', {
    headers: { Range: 'bytes=0-524287' }
  }).then(function (r) {
    return r.arrayBuffer().then(function (ab) {
      var b = new Uint8Array(ab);
      var str = '';
      // Print the first 400 bytes as ASCII-ish so we can read the box tree.
      for (var i = 0; i < Math.min(b.length, 400); i++) {
        var c = b[i];
        str += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
      // Scan for the codec fourccs in the sample description.
      var all = '';
      for (var j = 0; j < Math.min(b.length, 4096); j++) {
        var d = b[j];
        all += (d >= 32 && d < 127) ? String.fromCharCode(d) : ' ';
      }
      function find4(tag) { return all.indexOf(tag) >= 0; }

      // What codecs does this engine claim to support?
      var sup = [];
      ['video/mp4; codecs="hvc1.1.6.L120.90"',
       'video/mp4; codecs="hev1.1.6.L120.90"',
       'video/mp4; codecs="avc1.640028"',
       'video/mp4; codecs="avc1.42E01E"',
       'video/mp4'].forEach(function (m) {
        sup.push(m + ' = ' + (window.MediaSource ? MediaSource.isTypeSupported(m) : 'no-MS'));
      });
      var v = document.createElement('video');
      sup.push('canPlay hvcc = ' + v.canPlayType('video/mp4; codecs="hvc1"'));
      sup.push('canPlay hev1 = ' + v.canPlayType('video/mp4; codecs="hev1"'));
      sup.push('canPlay avc1 = ' + v.canPlayType('video/mp4; codecs="avc1.42E01E"'));

      return JSON.stringify({
        httpStatus: r.status,
        bytes: b.length,
        first400: str,
        boxTags: {
          ftyp: find4('ftyp'),
          moov: find4('moov'),
          mvhd: find4('mvhd'),
          trak: find4('trak'),
          stsd: find4('stsd'),
          encv: find4('encv'),
          hvc1: find4('hvc1'),
          hev1: find4('hev1'),
          avc1: find4('avc1'),
          enca: find4('enca'),
          sinf: find4('sinf'),
          mdat: find4('mdat'),
          hvcC: find4('hvcC'),
          avcC: find4('avcC'),
          clap: find4('clap'),
          pasp: find4('pasp')
        },
        support: sup
      }, null, 2);
    });
  }).catch(function (e) {
    return JSON.stringify({ fetchError: String(e) });
  });
})()
