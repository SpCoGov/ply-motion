分析与提取说明

源文件：C:/Users/Administrator/Desktop/新建 文本文档.txt
文件大小：2860064 字节。内容是截取的 JavaScript 打包代码，包含国际象棋界面图标，不是一个完整 SVG 文件。文件以 SVG 内容开始、以 JavaScript 逗号结束。

提取结果：
- svg/：63 个可独立打开的 SVG。其中 3 个原始完整静态 SVG，60 个由图标片段封装而成。
- templates/：2 个完整动态 SVG 模板，2 个动态坐标文字模板。保留原文，未猜测运行时内容。
- original-fragments/：60 个片段的原始文本，包含原来的变量占位符。
- index.html：本地图库预览，点击可打开 SVG。
- manifest.json：文件名、原变量名、源行号和字符位置。字符位置从 0 开始，按 JavaScript UTF-16 计数。
- external-svg-references.txt：7 个去重后的 SVG 路径或路径模板；源文件没有包含它们的图像内容，因此无法从本文件还原。

处理方式：完整静态 SVG 原样保留；图标片段只补齐 SVG 外层，并根据原代码将 W.ClassNames / zs 常量替换为实际 class 名称。viewBox 使用源代码 Aa() 默认值 0 0 18 19，导出尺寸为 72 × 76，可无损缩放。未执行源文件 JavaScript。外部 CSS 可能影响原站展示，导出保留片段自带颜色与样式。

可重新运行：node extract.cjs
