import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
const configuredOrigins = new Set(
  (process.env.APP_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
);
const trustProxy = process.env.TRUST_PROXY === "true";

if (trustProxy) app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
if (configuredOrigins.size > 0) {
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      callback(null, !origin || configuredOrigins.has(origin));
    },
  }));
}
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use((req, res, next): void => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.headers.origin) {
    next();
    return;
  }
  try {
    const origin = new URL(req.headers.origin);
    const forwardedHost = trustProxy
      ? req.get("x-forwarded-host")?.split(",", 1)[0]?.trim()
      : undefined;
    const forwardedProtocol = trustProxy
      ? req.get("x-forwarded-proto")?.split(",", 1)[0]?.trim()
      : undefined;
    const requestHost = forwardedHost || req.get("host");
    const requestProtocol = forwardedProtocol || req.protocol;
    if (
      origin.origin === `${requestProtocol}://${requestHost}`
      || configuredOrigins.has(origin.origin)
    ) {
      next();
      return;
    }
  } catch {
    // A malformed browser Origin is not trusted.
  }
  res.status(403).json({ error: "Origin not allowed" });
});

app.use("/api", router);

export default app;
