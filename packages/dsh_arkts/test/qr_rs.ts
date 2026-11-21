/**
 * Reed-Solomon 的断言。
 *
 * 金标取自 QR 规范里那个被反复引用的例子：版本 1-M、内容 "01234567"，数据码字
 * 16 个、纠错码字 10 个。用它而不是自己生成再自己解，是因为「编码和解码一起错」
 * 会互相抵消，测试仍然是绿的。
 */

import { evaluate, multiply, divide, inverse, powerOfAlpha } from '../src/qr/gf256'
import { correct, encodeBlock, generatorPolynomial, syndromes } from '../src/qr/rs'

let failures = 0

function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok  ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}`)
}

function same(label: string, actual: number, expected: number): void {
  ok(`${label} (got ${actual})`, actual === expected)
}

function sameBytes(label: string, actual: readonly number[], expected: readonly number[]): void {
  const equal = actual.length === expected.length && actual.every((value, index) => value === expected[index])
  ok(`${label} (got [${actual.join(',')}])`, equal)
}

function checkField(): void {
  same('alpha^0 is 1', powerOfAlpha(0), 1)
  same('alpha^1 is 2', powerOfAlpha(1), 2)
  same('alpha^8 wraps the primitive polynomial', powerOfAlpha(8), 0x1d)
  same('alpha^255 comes back to 1', powerOfAlpha(255), 1)
  same('a negative exponent wraps', powerOfAlpha(-1), powerOfAlpha(254))
  same('3 times 7 is 9', multiply(3, 7), 9)
  same('multiplying by zero is zero', multiply(0, 55), 0)
  same('dividing undoes multiplying', divide(multiply(55, 77), 77), 55)
  same('the inverse multiplies back to one', multiply(55, inverse(55)), 1)
  ok('every non-zero element has an inverse', Array.from({ length: 255 }, (_, index) => multiply(index + 1, inverse(index + 1))).every((value) => value === 1))
}

function checkGenerator(): void {
  // The degree here is the number of parity bytes, and the top coefficient is
  // always 1.
  same('the generator for 7 has degree 7', generatorPolynomial(7).length - 1, 7)
  same('the generator for 10 has degree 10', generatorPolynomial(10).length - 1, 10)
  same('the leading coefficient is 1', generatorPolynomial(10)[10], 1)
  // A generator is the product of (x - alpha^i), so it vanishes at each root.
  const generator = generatorPolynomial(10)
  let vanishes = true
  for (let index = 0; index < 10; index += 1) {
    // Index 0 is the constant term, so the last coefficient multiplies x^10.
    if (evaluate(generator, powerOfAlpha(index)) !== 0) vanishes = false
  }
  ok('the generator vanishes at every root', vanishes)
}

const SPEC_DATA = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17]
const SPEC_EC = [165, 36, 212, 193, 237, 54, 199, 135, 44, 85]

function checkSpeechExample(): void {
  sameBytes('the specification example encodes to the expected parity', encodeBlock(SPEC_DATA, 10), SPEC_EC)
  const codeword = SPEC_DATA.concat(SPEC_EC)
  ok('a clean codeword has zero syndromes', syndromes(codeword, 10).every((value) => value === 0))

  const damaged = codeword.slice()
  damaged[0] ^= 0x55
  damaged[7] ^= 0x11
  damaged[20] ^= 0x03
  ok('three damaged bytes still produce syndromes', syndromes(damaged, 10).some((value) => value !== 0))
  const repaired = damaged.slice()
  const changed = correct(repaired, 10)
  same('the corrector reports three repairs', changed, 3)
  sameBytes('the repaired codeword matches the original', repaired, codeword)

  const single = codeword.slice()
  single[25] ^= 0xa5
  const singleFixed = single.slice()
  same('a single damaged byte is repaired', correct(singleFixed, 10), 1)
  sameBytes('the single repair is exact', singleFixed, codeword)

  // Beyond half the parity, the corrector must refuse rather than guess: a
  // silently wrong framing here would become an unusable pairing code.
  const hopeless = codeword.slice()
  for (let index = 0; index < 7; index += 1) hopeless[index * 3] ^= 0x7f
  let refused = false
  try {
    correct(hopeless.slice(), 10)
  } catch {
    refused = true
  }
  ok('seven damaged bytes are refused, not guessed', refused)
}

function checkRoundTrip(): void {
  let roundTrips = 0
  for (const ecCount of [7, 10, 13, 17, 26, 30]) {
    const data = Array.from({ length: 20 }, (_, index) => (index * 37 + ecCount) & 0xff)
    const codeword = data.concat(encodeBlock(data, ecCount))
    for (let damaged = 0; damaged <= Math.floor(ecCount / 2); damaged += 1) {
      const broken = codeword.slice()
      for (let index = 0; index < damaged; index += 1) {
        broken[(index * 5 + 1) % broken.length] ^= 0x3f + index
      }
      const fixed = broken.slice()
      correct(fixed, ecCount)
      if (!fixed.every((value, index) => value === codeword[index])) {
        ok(`round trip ec=${ecCount} damaged=${damaged}`, false)
        return
      }
      roundTrips += 1
    }
  }
  // 4+6+7+9+14+16: every count of damaged bytes up to half the parity, for six
  // parity sizes.
  ok(`every corruption up to half the parity is repaired (${roundTrips} cases)`, roundTrips === 56)
}

checkField()
checkGenerator()
checkSpeechExample()
checkRoundTrip()

if (failures > 0) {
  console.log(`\nREED-SOLOMON CHECKS FAILED (${failures})`)
  process.exitCode = 1
} else {
  console.log('\nALL REED-SOLOMON CHECKS PASS (typescript core)')
}
