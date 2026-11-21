@Entry
@Component
struct Index {
  @State message: string = 'Pocket Harness';
  build() {
    Column() {
      Text(this.message).fontSize(24)
      Button('配对').onClick(() => { this.message = '已配对'; })
    }.width('100%').height('100%')
  }
}
