import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { User as SelectUser } from "@shared/schema";
import { log } from "./vite";
import crypto from 'crypto';

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string) {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

export function setupAuth(app: Express) {
  log("[Auth] Setting up authentication...");

  const sessionSettings: session.SessionOptions = {
    secret: process.env.REPL_ID!,
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      secure: app.get("env") === "production",
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  };

  if (app.get("env") === "production") {
    app.set("trust proxy", 1);
  }

  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        log(`[Auth] Login attempt for user: ${username}`);
        const user = await storage.getUserByUsername(username);

        if (!user) {
          log(`[Auth] Login failed - user not found: ${username}`);
          return done(null, false, { message: "Invalid username or password" });
        }

        const isValid = await comparePasswords(password, user.password);
        if (!isValid) {
          log(`[Auth] Login failed - invalid password: ${username}`);
          return done(null, false, { message: "Invalid username or password" });
        }

        log(`[Auth] Login successful: ${username}`);
        return done(null, user);
      } catch (error) {
        log(`[Auth] Login error for ${username}: ${error}`);
        return done(error);
      }
    }),
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id: number, done) => {
    try {
      const user = await storage.getUser(id);
      if (!user) {
        log(`[Auth] Deserialization failed - user not found: ${id}`);
        return done(null, false);
      }
      done(null, user);
    } catch (error) {
      log(`[Auth] Deserialization error for ID ${id}: ${error}`);
      done(error);
    }
  });

  // Registration endpoint
  app.post("/api/register", async (req, res, next) => {
    try {
      log(`[Auth] Registration attempt: ${req.body.username}`);

      const { username, password } = req.body;
      if (!username || !password) {
        throw new Error("Username and password are required");
      }

      const existingUser = await storage.getUserByUsername(username);
      if (existingUser) {
        log(`[Auth] Registration failed - username exists: ${username}`);
        return res.status(400).json({ error: "Username already exists" });
      }

      // Generate keys for Nostr
      const privateKeyBytes = new Uint8Array(32);
      crypto.getRandomValues(privateKeyBytes);
      const privateKey = Array.from(privateKeyBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      const publicKey = privateKey; // For testing only


      const user = await storage.createUser({
        username,
        password: await hashPassword(password),
        privateKey,
        publicKey
      });

      log(`[Auth] User registered successfully: ${username}`);

      req.login(user, (err) => {
        if (err) {
          log(`[Auth] Login after registration failed: ${err}`);
          return next(err);
        }
        res.status(201).json(user);
      });
    } catch (error: any) {
      log(`[Auth] Registration error: ${error.message}`);
      next(error);
    }
  });

  // Login endpoint
  app.post("/api/login", (req, res, next) => {
    passport.authenticate("local", (err: Error | null, user: Express.User | false, info: { message: string } | undefined) => {
      if (err) {
        log(`[Auth] Login error: ${err.message}`);
        return next(err);
      }
      if (!user) {
        log(`[Auth] Login failed: ${info?.message}`);
        return res.status(401).json({ error: info?.message || "Authentication failed" });
      }
      req.login(user, (err) => {
        if (err) {
          log(`[Auth] Session creation error: ${err.message}`);
          return next(err);
        }
        log(`[Auth] User logged in successfully: ${user.username}`);
        res.json(user);
      });
    })(req, res, next);
  });

  // Logout endpoint
  app.post("/api/logout", (req, res, next) => {
    const username = req.user?.username;
    log(`[Auth] Logout attempt: ${username}`);

    req.logout((err) => {
      if (err) {
        log(`[Auth] Logout error: ${err.message}`);
        return next(err);
      }
      log(`[Auth] User logged out successfully: ${username}`);
      res.sendStatus(200);
    });
  });

  // User info endpoint
  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) {
      log(`[Auth] Unauthorized access to /api/user`);
      return res.status(401).json({ error: "Not authenticated" });
    }
    log(`[Auth] User data retrieved: ${req.user.username}`);
    res.json(req.user);
  });

  log("[Auth] Authentication setup completed");
}