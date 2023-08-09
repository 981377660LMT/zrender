/*!
 * ZRender, a high performance 2d drawing library.
 *
 * Copyright (c) 2013, Baidu Inc.
 * All rights reserved.
 *
 * LICENSE
 * https://github.com/ecomfe/zrender/blob/master/LICENSE.txt
 */

import env from './core/env'
import * as zrUtil from './core/util'
import Handler from './Handler'
import Storage from './Storage'
import { PainterBase } from './PainterBase'
import Animation, { getTime } from './animation/Animation'
import HandlerProxy from './dom/HandlerProxy'
import Element, { ElementEventCallback } from './Element'
import { Dictionary, ElementEventName, RenderedEvent, WithThisType } from './core/types'
import { LayerConfig } from './canvas/Layer'
import { GradientObject } from './graphic/Gradient'
import { PatternObject } from './graphic/Pattern'
import { EventCallback } from './core/Eventful'
import Displayable from './graphic/Displayable'
import { lum } from './tool/color'
import { DARK_MODE_THRESHOLD } from './config'
import Group from './graphic/Group'

type PainterBaseCtor = {
  new (dom: HTMLElement, storage: Storage, ...args: any[]): PainterBase
}

// 用于存放渲染器
const painterCtors: Dictionary<PainterBaseCtor> = {}

let instances: { [key: number]: ZRender } = {}

function delInstance(id: number) {
  delete instances[id]
}

/**
 * Initializing a zrender instance
 * 初始化ZRender实例，需要传入dom节点作为canvas父级。
 *
 * @param dom Not necessary if using SSR painter like svg-ssr
 */
export function init(dom?: HTMLElement | null, opts?: ZRenderInitOpt) {
  console.log('hello zrender')
  const zr = new ZRender(zrUtil.guid(), dom, opts)
  instances[zr.id] = zr
  return zr
}

/**
 * Dispose zrender instance
 */
export function dispose(zr: ZRender) {
  zr.dispose()
}

/**
 * Dispose all zrender instances
 */
export function disposeAll() {
  for (let key in instances) {
    if (instances.hasOwnProperty(key)) {
      instances[key].dispose()
    }
  }
  instances = {}
}

/**
 * Get zrender instance by id
 */
export function getInstance(id: number): ZRender {
  return instances[id]
}

/**
 * 注册渲染器，系统在启动时会默认注册Canvas和SVG渲染器
 */
export function registerPainter(name: string, Ctor: PainterBaseCtor) {
  painterCtors[name] = Ctor
}

/**
 * @type {string}
 */
export const version = '5.4.3'

export interface ZRenderType extends ZRender {}

function isDarkMode(backgroundColor: string | GradientObject | PatternObject): boolean {
  if (!backgroundColor) {
    return false
  }
  if (typeof backgroundColor === 'string') {
    return lum(backgroundColor, 1) < DARK_MODE_THRESHOLD
  } else if ((backgroundColor as GradientObject).colorStops) {
    const colorStops = (backgroundColor as GradientObject).colorStops
    let totalLum = 0
    const len = colorStops.length
    // Simply do the math of average the color. Not consider the offset
    for (let i = 0; i < len; i++) {
      totalLum += lum(colorStops[i].color, 1)
    }
    totalLum /= len

    return totalLum < DARK_MODE_THRESHOLD
  }
  // Can't determine
  return false
}

// 用于管理ZRender实例里的所有元素对象实例，存储器（Storage）实例，渲染器（Painter）实例，事件控制器（Handler）实例，动画管理器（Animation）实例
class ZRender {
  /**
   * 画布渲染的容器根节点。
   * Not necessary if using SSR painter like svg-ssr
   */
  dom?: HTMLElement
  // zr实例id
  id: number

  // 存储器/渲染器/事件控制器/动画管理器
  storage: Storage
  painter: PainterBase
  handler: Handler
  animation: Animation

  private _sleepAfterStill = 10

  private _stillFrameAccum = 0

  private _needsRefresh = true
  private _needsRefreshHover = true

  /**
   * If theme is dark mode. It will determine the color strategy for labels.
   */
  private _darkMode = false

  private _backgroundColor: string | GradientObject | PatternObject

  constructor(id: number, dom?: HTMLElement, opts?: ZRenderInitOpt) {
    opts = opts || {}

    /**
     * @type {HTMLDomElement}
     */
    this.dom = dom

    this.id = id

    const storage = new Storage()

    let rendererType = opts.renderer || 'canvas'

    if (!painterCtors[rendererType]) {
      // Use the first registered renderer.
      rendererType = zrUtil.keys(painterCtors)[0]
    }
    if (process.env.NODE_ENV !== 'production') {
      if (!painterCtors[rendererType]) {
        throw new Error(`Renderer '${rendererType}' is not imported. Please import it first.`)
      }
    }

    // 脏矩形渲染
    opts.useDirtyRect = opts.useDirtyRect == null ? false : opts.useDirtyRect

    const painter = new painterCtors[rendererType](dom, storage, opts, id)
    const ssrMode = opts.ssr || painter.ssrOnly

    this.storage = storage
    this.painter = painter

    const handerProxy =
      !env.node && !env.worker && !ssrMode ? new HandlerProxy(painter.getViewportRoot(), painter.root) : null

    const useCoarsePointer = opts.useCoarsePointer
    // 扩大元素响应范围的像素大小，配合 `opts.useCoarsePointer` 使用。
    const usePointerSize =
      useCoarsePointer == null || useCoarsePointer === 'auto' ? env.touchEventsSupported : !!useCoarsePointer
    const defaultPointerSize = 44
    let pointerSize
    if (usePointerSize) {
      pointerSize = zrUtil.retrieve2(opts.pointerSize, defaultPointerSize)
    }

    this.handler = new Handler(storage, painter, handerProxy, painter.root, pointerSize)

    this.animation = new Animation({
      stage: {
        // 将渲染程序绑定到帧渲染策略
        update: ssrMode ? null : () => this._flush(true)
      }
    })

    if (!ssrMode) {
      this.animation.start()
    }
  }

  /**
   * 向画布添加元素，等待下一帧渲染
   */
  add(el: Element) {
    if (!el) {
      return
    }
    this.storage.addRoot(el)
    el.addSelfToZr(this)
    this.refresh()
  }

  /**
   * 从存储器中间元素删除，下一帧该元素将不会被渲染
   */
  remove(el: Element) {
    if (!el) {
      return
    }
    this.storage.delRoot(el)
    el.removeSelfFromZr(this)
    this.refresh()
  }

  /**
   * 配置层属性，在做动画的时候可以实现模糊效果。 以 canvas 为例，一个 canvas 就是一个层；
   * 如果重绘前透明的颜色来填充 canvas ，将会形成拖影的效果。
   */
  configLayer(zLevel: number, config: LayerConfig) {
    if (this.painter.configLayer) {
      this.painter.configLayer(zLevel, config)
    }
    this.refresh()
  }

  /**
   * Set background color
   */
  setBackgroundColor(backgroundColor: string | GradientObject | PatternObject) {
    if (this.painter.setBackgroundColor) {
      this.painter.setBackgroundColor(backgroundColor)
    }
    this.refresh()
    this._backgroundColor = backgroundColor
    this._darkMode = isDarkMode(backgroundColor)
  }

  getBackgroundColor() {
    return this._backgroundColor
  }

  /**
   * Force to set dark mode
   */
  setDarkMode(darkMode: boolean) {
    this._darkMode = darkMode
  }

  isDarkMode() {
    return this._darkMode
  }

  /**
   * 立即刷新, 不会等到浏览器的下一个刷新周期
   */
  refreshImmediately(fromInside?: boolean) {
    // const start = new Date();
    if (!fromInside) {
      // Update animation if refreshImmediately is invoked from outside.
      // Not trigger stage update to call flush again. Which may refresh twice
      this.animation.update(true)
    }

    // Clear needsRefresh ahead to avoid something wrong happens in refresh
    // Or it will cause zrender refreshes again and again.
    this._needsRefresh = false
    this.painter.refresh()
    // Avoid trigger zr.refresh in Element#beforeUpdate hook
    this._needsRefresh = false
  }

  /**
   * 在下一帧刷新.
   * Mark and repaint the canvas in the next frame of browser
   */
  refresh() {
    this._needsRefresh = true
    // Active the animation again.
    this.animation.start()
  }

  /**
   * !flush 为整个流程的入口， 在构造函数中 Animation 的参数就是 flush.
   * 立即触发 refresh 和 refreshHover 所标记的重绘操作。
   */
  flush() {
    this._flush(false)
  }

  private _flush(fromInside?: boolean) {
    let triggerRendered

    const start = getTime()
    if (this._needsRefresh) {
      triggerRendered = true
      this.refreshImmediately(fromInside)
    }

    if (this._needsRefreshHover) {
      triggerRendered = true
      this.refreshHoverImmediately()
    }
    const end = getTime()

    if (triggerRendered) {
      this._stillFrameAccum = 0
      this.trigger('rendered', {
        elapsedTime: end - start
      } as RenderedEvent)
    } else if (this._sleepAfterStill > 0) {
      this._stillFrameAccum++
      // Stop the animiation after still for 10 frames.
      if (this._stillFrameAccum > this._sleepAfterStill) {
        this.animation.stop()
      }
    }
  }

  /**
   * Set sleep after still for frames.
   * Disable auto sleep when it's 0.
   */
  setSleepAfterStill(stillFramesCount: number) {
    this._sleepAfterStill = stillFramesCount
  }

  /**
   * Wake up animation loop. But not render.
   */
  wakeUp() {
    this.animation.start()
    // Reset the frame count.
    this._stillFrameAccum = 0
  }

  /**
   * 刷新高亮层，将在下一个渲染帧的时候被刷新。
   * Refresh hover in next frame
   */
  refreshHover() {
    this._needsRefreshHover = true
  }

  /**
   * 强制立即刷新高亮层。
   */
  refreshHoverImmediately() {
    this._needsRefreshHover = false
    if (this.painter.refreshHover && this.painter.getType() === 'canvas') {
      this.painter.refreshHover()
    }
  }

  /**
   * 调整画布大小。
   * Resize the canvas.
   * Should be invoked when container size is changed
   */
  resize(opts?: { width?: number | string; height?: number | string }) {
    opts = opts || {}
    this.painter.resize(opts.width, opts.height)
    this.handler.resize()
  }

  /**
   * Stop and clear all animation immediately
   */
  clearAnimation() {
    this.animation.clear()
  }

  /**
   * Get container width
   */
  getWidth(): number {
    return this.painter.getWidth()
  }

  /**
   * Get container height
   */
  getHeight(): number {
    return this.painter.getHeight()
  }

  /**
   * Set default cursor
   * @param cursorStyle='default' 例如 crosshair
   */
  setCursorStyle(cursorStyle: string) {
    this.handler.setCursorStyle(cursorStyle)
  }

  /**
   * Find hovered element
   * @param x
   * @param y
   * @return {target, topTarget}
   */
  findHover(
    x: number,
    y: number
  ): {
    target: Displayable
    topTarget: Displayable
  } {
    return this.handler.findHover(x, y)
  }

  on<Ctx>(eventName: ElementEventName, eventHandler: ElementEventCallback<Ctx, ZRenderType>, context?: Ctx): this
  // eslint-disable-next-line max-len
  on<Ctx>(
    eventName: string,
    eventHandler: WithThisType<EventCallback<any[]>, unknown extends Ctx ? ZRenderType : Ctx>,
    context?: Ctx
  ): this
  // eslint-disable-next-line max-len
  on<Ctx>(eventName: string, eventHandler: (...args: any) => any, context?: Ctx): this {
    this.handler.on(eventName, eventHandler, context)
    return this
  }

  /**
   * Unbind event
   * @param eventName Event name
   * @param eventHandler Handler function
   */
  // eslint-disable-next-line max-len
  off(eventName?: string, eventHandler?: EventCallback) {
    this.handler.off(eventName, eventHandler)
  }

  /**
   * Trigger event manually
   *
   * @param eventName Event name
   * @param event Event object
   */
  trigger(eventName: string, event?: unknown) {
    this.handler.trigger(eventName, event)
  }

  /**
   * 清除所有对象和画布。
   */
  clear() {
    const roots = this.storage.getRoots()
    for (let i = 0; i < roots.length; i++) {
      if (roots[i] instanceof Group) {
        roots[i].removeSelfFromZr(this)
      }
    }
    this.storage.delAllRoots()
    this.painter.clear()
  }

  /**
   * 移除自身。当不再需要使用该实例时，调用该方法以释放内存。
   */
  dispose() {
    this.animation.stop()

    this.clear()
    this.storage.dispose()
    this.painter.dispose()
    this.handler.dispose()

    this.animation = this.storage = this.painter = this.handler = null

    delInstance(this.id)
  }
}

export interface ZRenderInitOpt {
  renderer?: string // 'canvas' or 'svg
  /** 画布大小与容器大小之比，仅当 renderer 为 'canvas' 时有效。 */
  devicePixelRatio?: number
  /** 画布宽度，设为 'auto' 则根据 devicePixelRatio 与容器宽度自动计算. */
  width?: number | string // 10, 10px, 'auto'
  height?: number | string

  /** 脏矩形渲染. */
  useDirtyRect?: boolean
  /** useCoarsePointer，5.4.0 版本起支持：是否扩大可点击元素的响应范围。 */
  useCoarsePointer?: 'auto' | boolean

  pointerSize?: number
  ssr?: boolean // If enable ssr mode.
}
