import { logger } from "@coder/logger"
import cookieParser from "cookie-parser"
import * as express from "express"
import { promises as fs } from "fs"
import * as path from "path"
import * as tls from "tls"
import * as pluginapi from "../../../typings/pluginapi"
import { Disposable } from "../../common/emitter"
import { HttpCode, HttpError } from "../../common/http"
import { plural } from "../../common/util"
import { App } from "../app"
import { AuthType, DefaultedArgs } from "../cli"
import { commit, rootPath } from "../constants"
import { Heart } from "../heart"
import { ensureAuthenticated, redirect } from "../http"
import { PluginAPI } from "../plugin"
import { getMediaMime, paths } from "../util"
import * as apps from "./apps"
import * as domainProxy from "./domainProxy"
import { errorHandler, wsErrorHandler } from "./errors"
import * as health from "./health"
import * as login from "./login"
import * as logout from "./logout"
import * as pathProxy from "./pathProxy"
import * as update from "./update"
import { CodeServerRouteWrapper } from "./vscode"

/**
 * Register all routes and middleware.
 */
export const register = async (app: App, args: DefaultedArgs): Promise<Disposable["dispose"]> => {
  const heart = new Heart(path.join(paths.data, "heartbeat"), async () => {
    return new Promise((resolve, reject) => {
      app.server.getConnections((error, count) => {
        if (error) {
          return reject(error)
        }
        logger.debug(plural(count, `${count} active connection`))
        resolve(count > 0)
      })
    })
  })

  app.router.disable("x-powered-by")
  app.wsRouter.disable("x-powered-by")

  app.router.use(cookieParser())
  app.wsRouter.use(cookieParser())

  const common: express.RequestHandler = (req, _, next) => {
    // /healthz|/healthz/ needs to be excluded otherwise health checks will make
    // it look like code-server is always in use.
    if (!/^\/healthz\/?$/.test(req.url)) {
      heart.beat()
    }

    // Add common variables routes can use.
    req.args = args
    req.heart = heart

    next()
  }

  app.router.use(common)
  app.wsRouter.use(common)

  app.router.use(async (req, res, next) => {
    // If we're handling TLS ensure all requests are redirected to HTTPS.
    // TODO: This does *NOT* work if you have a base path since to specify the
    // protocol we need to specify the whole path.
    if (args.cert && !(req.connection as tls.TLSSocket).encrypted) {
      return res.redirect(`https://${req.headers.host}${req.originalUrl}`)
    }

    // Return robots.txt.
    if (req.originalUrl === "/robots.txt") {
      const resourcePath = path.resolve(rootPath, "src/browser/robots.txt")
      res.set("Content-Type", getMediaMime(resourcePath))
      return res.send(await fs.readFile(resourcePath))
    }

    next()
  })

  app.router.use("/", domainProxy.router)
  app.wsRouter.use("/", domainProxy.wsRouter.router)

  app.router.all("/proxy/(:port)(/*)?", (req, res) => {
    pathProxy.proxy(req, res)
  })
  app.wsRouter.get("/proxy/(:port)(/*)?", async (req) => {
    await pathProxy.wsProxy(req as pluginapi.WebsocketRequest)
  })
  // These two routes pass through the path directly.
  // So the proxied app must be aware it is running
  // under /absproxy/<someport>/
  app.router.all("/absproxy/(:port)(/*)?", (req, res) => {
    pathProxy.proxy(req, res, {
      passthroughPath: true,
    })
  })
  app.wsRouter.get("/absproxy/(:port)(/*)?", async (req) => {
    await pathProxy.wsProxy(req as pluginapi.WebsocketRequest, {
      passthroughPath: true,
    })
  })

  let pluginApi: PluginAPI
  if (!process.env.CS_DISABLE_PLUGINS) {
    const workingDir = args._ && args._.length > 0 ? path.resolve(args._[args._.length - 1]) : undefined
    pluginApi = new PluginAPI(logger, process.env.CS_PLUGIN, process.env.CS_PLUGIN_PATH, workingDir)
    await pluginApi.loadPlugins()
    pluginApi.mount(app.router, app.wsRouter)
    app.router.use("/api/applications", ensureAuthenticated, apps.router(pluginApi))
  }

  app.router.use(express.json())
  app.router.use(express.urlencoded({ extended: true }))

  app.router.use(
    "/_static",
    express.static(rootPath, {
      cacheControl: commit !== "development",
      fallthrough: false,
    }),
  )

  app.router.use("/healthz", health.router)
  app.wsRouter.use("/healthz", health.wsRouter.router)

  if (args.auth === AuthType.Password) {
    app.router.use("/login", login.router)
    app.router.use("/logout", logout.router)
  } else {
    app.router.all("/login", (req, res) => redirect(req, res, "/", {}))
    app.router.all("/logout", (req, res) => redirect(req, res, "/", {}))
  }

  app.router.use("/update", update.router)

  const vsServerRouteHandler = new CodeServerRouteWrapper()

  // Note that the root route is replaced in Coder Enterprise by the plugin API.
  for (const routePrefix of ["/", "/vscode"]) {
    app.router.use(routePrefix, vsServerRouteHandler.router)
    app.wsRouter.use(routePrefix, vsServerRouteHandler.wsRouter)
  }

  app.router.use(() => {
    throw new HttpError("Not Found", HttpCode.NotFound)
  })

  app.router.use(errorHandler)
  app.wsRouter.use(wsErrorHandler)

  return () => {
    heart.dispose()
    pluginApi?.dispose()
    vsServerRouteHandler.dispose()
  }
}
