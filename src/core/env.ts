// 这段代码主要用于检测和识别运行环境，包括浏览器类型、版本、是否支持 SVG、触摸事件、指针事件、DOM、2D/3D 变换等。
// 代码首先定义了两个类 Browser 和 Env，然后创建了一个 Env 类的实例 env，接着根据不同的运行环境进行检测和设置相应的属性。

// 首先判断是否在微信小程序环境中，如果是，则设置 env.wxa 为 true，并设置 env.touchEventsSupported 为 true。
// 接着判断是否在 Web Worker 环境中，如果是，则设置 env.worker 为 true。
// 然后判断是否在 Node.js 环境中，如果是，则设置 env.node 为 true，并设置 env.svgSupported 为 true。
// !最后，如果都不是以上环境，则认为是在浏览器环境中，调用 detect 函数进行浏览器类型和版本的检测。
// detect 函数主要通过分析 navigator.userAgent 字符串来识别浏览器类型和版本。具体步骤如下：

// 通过正则表达式匹配 Firefox、IE、Edge 和 WeChat 的版本信息。
// 根据匹配结果，设置 env.browser 的相关属性，如 firefox、ie、edge、newEdge 和 weChat。
// 判断是否支持 SVG，如果 SVGRect 存在，则设置 env.svgSupported 为 true。
// 判断是否支持触摸事件，如果 ontouchstart 存在于 window 对象中且不是 IE 和 Edge 浏览器，则设置 env.touchEventsSupported 为 true。
// 判断是否支持指针事件，如果 onpointerdown 存在于 window 对象中且是 Edge 或 IE11+ 浏览器，则设置 env.pointerEventsSupported 为 true。
// 判断是否支持 DOM，如果 document 存在，则设置 env.domSupported 为 true。
// 判断是否支持 3D 变换，根据不同浏览器的特性进行判断，如 IE9+、Edge、WebKit 和 Gecko 等，设置 env.transform3dSupported。
// 判断是否支持 2D 变换，如果支持 3D 变换或者是 IE9+ 浏览器，则设置 env.transformSupported 为 true。
// 最后，将 env 对象导出，供其他模块使用。

declare const wx: {
  getSystemInfoSync: Function
}

class Browser {
  firefox = false
  ie = false
  edge = false
  newEdge = false
  weChat = false
  version: string | number
}

class Env {
  browser = new Browser()
  node = false
  wxa = false
  worker = false

  svgSupported = false
  touchEventsSupported = false
  pointerEventsSupported = false
  domSupported = false
  transformSupported = false
  transform3dSupported = false

  hasGlobalWindow = typeof window !== 'undefined'
}

const env = new Env()

if (typeof wx === 'object' && typeof wx.getSystemInfoSync === 'function') {
  env.wxa = true
  env.touchEventsSupported = true
} else if (typeof document === 'undefined' && typeof self !== 'undefined') {
  // In worker
  env.worker = true
} else if (typeof navigator === 'undefined') {
  // In node
  env.node = true
  env.svgSupported = true
} else {
  detect(navigator.userAgent, env)
}

// Zepto.js
// (c) 2010-2013 Thomas Fuchs
// Zepto.js may be freely distributed under the MIT license.

function detect(ua: string, env: Env) {
  const browser = env.browser
  const firefox = ua.match(/Firefox\/([\d.]+)/)
  const ie =
    ua.match(/MSIE\s([\d.]+)/) ||
    // IE 11 Trident/7.0; rv:11.0
    ua.match(/Trident\/.+?rv:(([\d.]+))/)
  const edge = ua.match(/Edge?\/([\d.]+)/) // IE 12 and 12+

  const weChat = /micromessenger/i.test(ua)

  if (firefox) {
    browser.firefox = true
    browser.version = firefox[1]
  }
  if (ie) {
    browser.ie = true
    browser.version = ie[1]
  }

  if (edge) {
    browser.edge = true
    browser.version = edge[1]
    browser.newEdge = +edge[1].split('.')[0] > 18
  }

  // It is difficult to detect WeChat in Win Phone precisely, because ua can
  // not be set on win phone. So we do not consider Win Phone.
  if (weChat) {
    browser.weChat = true
  }

  env.svgSupported = typeof SVGRect !== 'undefined'
  env.touchEventsSupported = 'ontouchstart' in window && !browser.ie && !browser.edge
  env.pointerEventsSupported = 'onpointerdown' in window && (browser.edge || (browser.ie && +browser.version >= 11))
  env.domSupported = typeof document !== 'undefined'

  const style = document.documentElement.style

  env.transform3dSupported =
    // IE9 only supports transform 2D
    // transform 3D supported since IE10
    // we detect it by whether 'transition' is in style
    ((browser.ie && 'transition' in style) ||
      // edge
      browser.edge ||
      // webkit
      ('WebKitCSSMatrix' in window && 'm11' in new WebKitCSSMatrix()) ||
      // gecko-based browsers
      'MozPerspective' in style) && // Opera supports CSS transforms after version 12
    !('OTransition' in style)

  // except IE 6-8 and very old firefox 2-3 & opera 10.1
  // other browsers all support `transform`
  env.transformSupported =
    env.transform3dSupported ||
    // transform 2D is supported in IE9
    (browser.ie && +browser.version >= 9)
}

export default env
