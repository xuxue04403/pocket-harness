// Validates host/chacha20_poly1305.js against the RFC 8439 test vectors.
//
// The Node responder cannot lean on `node:crypto` here (the Electron build has
// no chacha20-poly1305), so the AEAD is hand-written and must prove itself
// against the RFC rather than only against its own round trip.

import { open, poly1305, seal, chacha20Xor } from '../host/chacha20_poly1305.js'

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex')
const eq = (a, b) => Buffer.from(a).equals(Buffer.from(b))

let failures = 0
function check(label, actual, expected) {
  const ok = eq(actual, expected)
  if (!ok) {
    failures += 1
    console.log(`FAIL ${label}\n  expected ${Buffer.from(expected).toString('hex')}\n  actual   ${Buffer.from(actual).toString('hex')}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

// RFC 8439 §2.4.2: the ChaCha20 block function.
const blockKey = hex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const blockNonce = hex('000000090000004a00000000')
check(
  'chacha20 block (RFC 8439 §2.4.2)',
  chacha20Xor(blockKey, blockNonce, 1, new Uint8Array(64)),
  hex(`10 f1 e7 e4 d1 3b 59 15 50 0f dd 1f a3 20 71 c4
       c7 d1 f4 c7 33 c0 68 03 04 22 aa 9a c3 d4 6c 4e
       d2 82 64 46 07 9f aa 09 14 c2 d7 05 d9 8b 02 a2
       b5 12 9c d1 de 16 4e b9 cb d0 83 e8 a2 50 3c 4e`),
)

// RFC 8439 §2.5.2: the Poly1305 one-time tag.
check(
  'poly1305 (RFC 8439 §2.5.2)',
  poly1305(
    hex('85 d6 be 78 57 55 6d 33 7f 44 52 fe 42 d5 06 a8 01 03 80 8a fb 0d b2 fd 4a bf f6 af 41 49 f5 1b'),
    Buffer.from('Cryptographic Forum Research Group', 'utf8'),
  ),
  hex('a8 06 1d c1 30 51 36 c6 c2 2b 8b af 0c 01 27 a9'),
)

// RFC 8439 §2.8.2: the AEAD.
const aeadKey = hex('80 81 82 83 84 85 86 87 88 89 8a 8b 8c 8d 8e 8f 90 91 92 93 94 95 96 97 98 99 9a 9b 9c 9d 9e 9f')
const aeadNonce = hex('07 00 00 00 40 41 42 43 44 45 46 47')
const aeadAad = hex('50 51 52 53 c0 c1 c2 c3 c4 c5 c6 c7')
const aeadPlaintext = Buffer.from(
  "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  'utf8',
)
const expectedCiphertext = hex(`
  d3 1a 8d 34 64 8e 60 db 7b 86 af bc 53 ef 7e c2
  a4 ad ed 51 29 6e 08 fe a9 e2 b5 a7 36 ee 62 d6
  3d be a4 5e 8c a9 67 12 82 fa fb 69 da 92 72 8b
  1a 71 de 0a 9e 06 0b 29 05 d6 a5 b6 7e cd 3b 36
  92 dd bd 7f 2d 77 8b 8c 98 03 ae e3 28 09 1b 58
  fa b3 24 e4 fa d6 75 94 55 85 80 8b 48 31 d7 bc
  3f f4 de f0 8e 4b 7a 9d e5 76 d2 65 86 ce c6 4b
  61 16
`)
const expectedTag = hex('1a e1 0b 59 4f 09 e2 6a 7e 90 2e cb d0 60 06 91')

const sealed = seal(aeadKey, aeadNonce, aeadAad, aeadPlaintext)
check('aead ciphertext (RFC 8439 §2.8.2)', sealed.subarray(0, sealed.length - 16), expectedCiphertext)
check('aead tag (RFC 8439 §2.8.2)', sealed.subarray(sealed.length - 16), expectedTag)
check('aead round trip', open(aeadKey, aeadNonce, aeadAad, sealed), aeadPlaintext)

const corrupted = Buffer.from(sealed)
corrupted[0] ^= 0xff
check('aead rejects corruption', String(open(aeadKey, aeadNonce, aeadAad, corrupted) === null), 'true')

console.log(failures === 0 ? 'ALL RFC 8439 VECTORS PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
