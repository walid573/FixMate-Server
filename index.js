import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";
import { jwtVerify } from "jose";


const app = express();

const port = process.env.PORT || 8000;


const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!stripeSecretKey) {
  throw new Error("STRIPE_SECRET_KEY is missing");
}

if (!webhookSecret) {
  throw new Error("STRIPE_WEBHOOK_SECRET is missing");
}

const stripe = new Stripe(stripeSecretKey);

// Helper function to fetch receipt URL from Stripe payment intent.
// IMPORTANT: stripe-node v23 / the current Stripe API removed the
// PaymentIntent.charges list. Expanding "charges" silently returned nothing,
// so receipt_url was ALWAYS null. The correct field is "latest_charge".
async function fetchReceiptUrl(stripePaymentIntentId) {
  if (!stripePaymentIntentId) return null;

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(
      stripePaymentIntentId,
      { expand: ["latest_charge"] }
    );

    let charge = paymentIntent?.latest_charge;
    if (typeof charge === "string") {
      charge = await stripe.charges.retrieve(charge);
    }
    if (charge?.receipt_url) return charge.receipt_url;

    // Fallback for intents where latest_charge is missing.
    const list = await stripe.charges.list({
      payment_intent: stripePaymentIntentId,
      limit: 1,
    });
    const first = list?.data?.[0];
    if (first?.receipt_url) return first.receipt_url;
    if (first?.id) {
      const fullCharge = await stripe.charges.retrieve(first.id);
      return fullCharge?.receipt_url || null;
    }
    return null;
  } catch (err) {
    console.error("Failed to fetch receipt URL:", err.message);
    return null;
  }
}

// Fetch + cache a receipt for a payment record that was saved before Stripe
// had generated the receipt URL (common right after Checkout redirects).
async function backfillPaymentReceipt(payment) {
  if (!payment) return null;
  if (payment.receiptUrl) return payment.receiptUrl;
  if (!payment.stripePaymentIntentId) return null;

  const receiptUrl = await fetchReceiptUrl(payment.stripePaymentIntentId);
  if (receiptUrl) {
    await payments.updateOne(
      { _id: payment._id },
      { $set: { receiptUrl } }
    );
  }
  return receiptUrl;
}

// Helper function to fetch payment method details from Stripe
async function fetchPaymentMethod(stripePaymentIntentId) {
  if (!stripePaymentIntentId) return null;

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(
      stripePaymentIntentId,
      { expand: ["payment_method", "latest_charge"] }
    );

    // Try payment_method first
    const pm = paymentIntent?.payment_method;
    if (pm && typeof pm !== "string" && pm.card) {
      return { brand: pm.card.brand, last4: pm.card.last4 };
    }

    // Fallback: latest_charge (not the removed `charges` list)
    let charge = paymentIntent?.latest_charge;
    if (typeof charge === "string") {
      charge = await stripe.charges.retrieve(charge);
    }
    const card = charge?.payment_method_details?.card;
    if (card) return { brand: card.brand, last4: card.last4 };

    return null;
  } catch (err) {
    console.error("Failed to fetch payment method:", err.message);
    return null;
  }
}




app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        webhookSecret
      );
    } catch (err) {
      console.error("Stripe signature verification failed:", err.message);

      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        if (session.payment_status !== "paid") {
          return res.status(200).json({ received: true });
        }

        const bookingId = session.metadata?.bookingId;

        if (!bookingId || !ObjectId.isValid(bookingId)) {
          console.error("Invalid booking ID:", bookingId);
          return res.status(400).json({ message: "Invalid booking ID" });
        }

        const booking = await bookings.findOne({
          _id: new ObjectId(bookingId),
        });

        if (!booking) {
          console.error("Booking not found:", bookingId);
          return res.status(404).json({ message: "Booking not found" });
        }

        // Pay-after-service: Stripe sessions are only created for completed
        // jobs; refuse to settle anything else even if a session exists.
        if (booking.status !== "completed") {
          console.error("Webhook refused non-completed booking:", bookingId);
          return res.status(400).json({ message: "Booking is not completed" });
        }

        const paymentData = {
          bookingId: String(booking._id),
          stripeSessionId: session.id,
          stripePaymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : "",
          // Design field name for the Stripe payment intent id.
          transactionId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : "",
          customerName: booking.customerName || "",
          customerEmail: booking.customerEmail,
          technicianName: booking.technicianName || "",
          technicianEmail: booking.technicianEmail || "",
          serviceTitle: booking.serviceTitle,
          amount: (session.amount_total || 0) / 100,
          currency: session.currency || "usd",
          paymentStatus: "paid",
          paidAt: new Date(),
          createdAt: new Date(),
        };

        // Try to retrieve receipt URL and payment method from Stripe payment intent
        if (paymentData.stripePaymentIntentId) {
          try {
            paymentData.receiptUrl = await fetchReceiptUrl(
              paymentData.stripePaymentIntentId
            );
          } catch (err) {
            console.error("Failed to retrieve receipt URL:", err.message);
          }
          
          try {
            paymentData.paymentMethod = await fetchPaymentMethod(
              paymentData.stripePaymentIntentId
            );
          } catch (err) {
            console.error("Failed to retrieve payment method:", err.message);
          }
        }

        // Idempotent payment insertion
        try {
          await payments.updateOne(
            { stripeSessionId: session.id },
            {
              $setOnInsert: paymentData,
              // A retry must also be able to repair an older record that was
              // saved before the receipt_url fix shipped.
              ...(paymentData.receiptUrl && {
                $set: {
                  receiptUrl: paymentData.receiptUrl,
                  ...(paymentData.paymentMethod && {
                    paymentMethod: paymentData.paymentMethod,
                  }),
                },
              }),
            },
            { upsert: true }
          );
        } catch (err) {
          if (err.code !== 11000) throw err;
        }

        // Always synchronize the booking
        await bookings.updateOne(
          { _id: booking._id },
          {
            $set: {
              paymentStatus: "paid",
              paidAt: new Date(),
              stripeSessionId: session.id,
              stripePaymentIntentId:
                paymentData.stripePaymentIntentId,
              updatedAt: new Date(),
            },
          }
        );

        console.log(
          "Payment successfully processed:",
          bookingId
        );
      }

      return res.status(200).json({ received: true });

    } catch (error) {
      console.error("Webhook processing failed:", error);

      return res.status(500).json({
        message: "Webhook processing failed",
      });
    }
  }
);


// The assignment spells private endpoints with an /api prefix. The Next.js
// app talks to the bare Express paths, so simply drop "/api" and keep the rest
// of the path intact. Stripping "/api/admin" as well used to collide with the
// customer routes (/api/admin/bookings -> /bookings) and 404 on the receipt
// route. /admin/* aliases are registered next to each bare route below.
app.use((req, _res, next) => {
  if (req.url.startsWith("/api/")) {
    req.url = req.url.slice("/api".length);
  }
  next();
});

// Normal JSON middleware AFTER Stripe webhook
app.use(express.json());

// Allow every client origin we actually serve. The deployed app can be
// reached under both the preview and the production Vercel domain, so a
// single CLIENT_URL is not enough.
const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.CLIENT_URLS,
  "https://fixmate-client24.vercel.app",
  "https://fixmate-client-wine.vercel.app",
  "http://localhost:3000",
]
  .flatMap((value) => (value || "").split(","))
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Non-browser requests (server actions, health checks) have no Origin.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, origin || true);
      }
      // Don't throw — that would turn a disallowed browser origin into a
      // 500. Simply omit the ACAO header so the browser blocks the response.
      return callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// MongoDB connection
const mongoUrl = process.env.MONGODB_URL;


if (!mongoUrl) {
  throw new Error("MONGODB_URL is missing from environment variables");
}

// Reuse ONE small pool across warm serverless invocations. A fresh client per
// invocation (plus the old per-request client in the Next.js role route) is
// what pushed Atlas to 500/500 connections. Keep the pool tiny on purpose.
const globalForMongo = globalThis;
const mongoState =
  globalForMongo.__fixmateServerMongoState ??
  (globalForMongo.__fixmateServerMongoState = { client: null, promise: null });

if (!mongoState.client) {
  mongoState.client = new MongoClient(mongoUrl, {
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 30_000,
    serverSelectionTimeoutMS: 10_000,
    waitQueueTimeoutMS: 5_000,
  });
}
const client = mongoState.client;

export async function connectToMongoDB() {
  if (!mongoState.promise) {
    mongoState.promise = client.connect()
      .then(() => {
        console.log("Successfully connected to MongoDB!");
        return client;
      })
      .catch((error) => {
        mongoState.promise = null; // allow a retry on the next invocation
        console.error("MongoDB connection failed:", error);
        throw error;
      });
  }
  return mongoState.promise;
}

const connectClient = await connectToMongoDB();

const db = connectClient.db("fixmate");

const users = db.collection("users");
const services = db.collection("services");
const bookings = db.collection("bookings")
const payments = db.collection("payments");

// ---- Shared query helpers -------------------------------------------------
const escapeRe = (value) =>
  String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case-insensitive, whole-value match (emails, exact mode names, ...).
const ciExact = (value) => ({
  $regex: `^${escapeRe(value)}$`,
  $options: "i",
});

// Category matching that treats "Laptop & PC", "laptop-pc" and "LAPTOP PC"
// as the same category. This lets the home-page category cards and the
// /services dropdown agree even though one uses slugs and one uses labels.
const categoryMatcher = (value) => {
  const parts = String(value ?? "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(escapeRe);

  if (!parts.length) return undefined;
  if (parts.length === 1) {
    // A single word may be the start of a longer category ("laptop" -> "Laptop & PC").
    return { $regex: `^${parts[0]}(?:[^a-zA-Z0-9].*)?$`, $options: "i" };
  }
  return {
    $regex: `^${parts.join("[^a-zA-Z0-9]*")}$`,
    $options: "i",
  };
};





// 1. Verify authentication token
//
// The Next.js better-auth config signs the JWT with HS256 using the shared
// JWT_SECRET (see src/lib/auth.ts). We must verify with the SAME algorithm and
// secret — verifying an HS256 token against a remote JWKS (RS256) always fails
// with 401, which is what starved every protected endpoint of data.
const AUTH_URL = process.env.AUTH_URL;
// AUTH_URL is optional now. Tokens are authenticated by the shared JWT_SECRET
// (HS256), so a client-URL mismatch can no longer reject every request.

// AUTH_URL may hold several client URLs, comma-separated, e.g.
// "http://localhost:3000,https://fix-mate-client.vercel.app" - so the same
// server accepts tokens from both a local and a deployed client.
const AUTH_URLS = (AUTH_URL || "").split(",")
  .map((u) => u.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error("JWT_SECRET is missing from .env");

const jwtKey = new TextEncoder().encode(jwtSecret);

// Pin the algorithm. Issuer/audience are only enforced if you opt in by setting
// ENFORCE_TOKEN_ISSUER=true (then AUTH_URL must list every client URL).
const verifyOptions = { algorithms: ["HS256"] };
if (process.env.ENFORCE_TOKEN_ISSUER === "true" && AUTH_URLS.length) {
  verifyOptions.issuer = AUTH_URLS;
  verifyOptions.audience = AUTH_URLS;
}

const verifyToken = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { payload } = await jwtVerify(
      header.split(" ")[1],
      jwtKey,
      verifyOptions
    );

    // Take the role from the DB, not the token, so role changes apply instantly
    const user = await users.findOne({ email: payload.email });
    if (!user) return res.status(401).json({ message: "Unauthorized" });

    req.user = user;
    next();
  } catch (err) {
    console.error("verifyToken rejected a request:", err?.code || err?.message);
    res.status(401).json({ message: "Unauthorized" });
  }
};

// 2. Verify customer
const verifyCustomer = (req, res, next) => {
  if (req.user?.role !== "customer") {
    return res.status(403).send({
      message: "Forbidden",
    });
  }

  next();
};

// 3. Verify technician
const verifyTechnician = (req, res, next) => {
  if (req.user?.role !== "technician") {
    return res.status(403).send({
      message: "Forbidden",
    });
  }

  next();
};

// 4. Verify admin
const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({
      message: "Forbidden",
    });
  }

  next();
};

// Optional auth for the PUBLIC catalogue endpoints. Anonymous callers and
// customers are allowed through (visibility is then forced in the handler),
// but a valid token lets admins/technicians see their own listings.
const optionalAuth = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const { payload } = await jwtVerify(
        header.split(" ")[1],
        jwtKey,
        verifyOptions
      );
      const user = await users.findOne({ email: payload.email });
      if (user) req.user = user;
    } catch {
      // Expired/invalid token on a public route: treat as anonymous.
    }
  }
  next();
};




await payments.createIndexes([
  {
    key: { bookingId: 1 },
    name: "unique_bookingId",
    unique: true,
    partialFilterExpression: {
      bookingId: { $type: "string" },
    },
  },
  {
    key: { stripeSessionId: 1 },
    name: "unique_stripeSessionId",
    unique: true,
    partialFilterExpression: {
      stripeSessionId: { $type: "string" },
    },
  },
]);

console.log("Payment indexes created successfully!");



// Home route
app.get("/", (req, res) => {
  res.send("Hello from FixMate Server!");
});

// Get featured services

app.get("/feature-services", async (req, res) => {
  try {
    const data = await services
      .find({
        approvalStatus: "approved",
        isAvailable: true,
      })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    console.log("Featured services:", data.length);

    res.status(200).json(data);
  } catch (error) {
    console.error("Featured services error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch featured services",
    });
  }
});



// Get all services — searching, filtering and sorting happen HERE, in MongoDB.
// Public browse sends approvalStatus/isAvailable; technician dashboards send
// technicianEmail/technicianId and deliberately omit those public filters.
app.get("/services", optionalAuth, async (req, res) => {
  try {
    const {
      technicianEmail,
      technicianId,
      search,
      category,
      mode,
      sort,
      approvalStatus,
      isAvailable,
    } = req.query;

    const query = {};
    const role = req.user?.role;

    // Public catalogue visibility. Only admins see everything; technicians
    // see just their own listings (any status) so My Services / edit keep
    // working. Everyone else — anonymous visitors and customers — can only
    // ever receive approved AND available services, no matter what query
    // params they supply.
    if (role === "technician") {
      query.technicianEmail = ciExact(req.user.email);
    } else if (role !== "admin") {
      query.approvalStatus = "approved";
      query.isAvailable = true;
    }

    if (technicianEmail) query.technicianEmail = ciExact(technicianEmail);
    if (technicianId) query.technicianId = String(technicianId);

    // Status/availability filters are meaningful only for privileged
    // callers. Public callers must not be able to widen visibility.
    if (approvalStatus && (role === "admin" || role === "technician")) {
      query.approvalStatus = String(approvalStatus);
    }
    if (
      (isAvailable === "true" || isAvailable === true) &&
      (role === "admin" || role === "technician")
    ) {
      query.isAvailable = true;
    }

    if (mode) query.serviceMode = ciExact(mode);

    const categoryFilter = category ? categoryMatcher(category) : undefined;
    if (categoryFilter) query.category = categoryFilter;

    // Search by service title or category. Match whole words (or word
    // beginnings), so "AC" doesn't accidentally match "Wa-shing Ma-chine".
    const term = String(search ?? "").trim();
    if (term) {
      const words = term.split(/\s+/).filter(Boolean).map(escapeRe);
      let pattern = words
        .map((word) => `(?:^|[^a-zA-Z0-9])${word}`)
        .join("[^a-zA-Z0-9]*");
      if (words.length === 1 && words[0].toLowerCase() === "ac") {
        pattern = `(?:^|[^a-zA-Z0-9])(?:ac|air condition(?:er|ing))`;
      }
      query.$or = [
        { title: { $regex: pattern, $options: "i" } },
        { category: { $regex: pattern, $options: "i" } },
      ];
    }

    // Sort entirely on the server. createdAt is the tie-breaker so documents
    // without a createdAt still get a stable "newest first" order.
    const sortSpec =
      sort === "price-asc"
        ? { basePrice: 1, _id: -1 }
        : sort === "price-desc"
        ? { basePrice: -1, _id: -1 }
        : { createdAt: -1, _id: -1 };

    const data = await services.find(query).sort(sortSpec).toArray();
    res.status(200).json(data);
  } catch (error) {
    console.error("Get services error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch services",
    });
  }
});

// Category options for the browse dropdown (a stable list, independent of the
// filters currently applied). Must be declared before /services/:id.
app.get("/services/categories", async (_req, res) => {
  try {
    const rows = await services
      .find({ approvalStatus: "approved", isAvailable: true })
      .project({ category: 1 })
      .toArray();
    const categories = [
      ...new Set(rows.map((r) => String(r.category || "").trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
    res.status(200).json(categories);
  } catch (error) {
    console.error("Get service categories error:", error);
    res.status(500).json({ message: "Failed to fetch categories." });
  }
});

// Public technician summary for service detail pages. Only non-sensitive
// profile fields are returned — never email, phone or role-management data.
app.get("/technicians", async (req, res) => {
  try {
    const { id, email } = req.query;
    if (!id && !email) {
      return res.status(400).json({ message: "id or email is required." });
    }

    let query;
    if (id) {
      query = ObjectId.isValid(id)
        ? { $or: [{ _id: new ObjectId(id) }, { _id: String(id) }] }
        : { _id: String(id) };
    } else {
      query = { email: ciExact(email) };
    }

    const user = await users.findOne(query, {
      projection: { name: 1, image: 1, area: 1, bio: 1 },
    });
    if (!user) {
      return res.status(404).json({ message: "Technician not found." });
    }

    res.status(200).json({
      _id: String(user._id),
      name: user.name || "",
      image: user.image || "",
      area: user.area || "",
      bio: user.bio || "",
    });
  } catch (error) {
    console.error("Get technician error:", error);
    res.status(500).json({ message: "Failed to fetch technician." });
  }
});

// Update a user's role (admin only). The handler is shared by the bare route
// and the /admin alias so the /api prefix rewrite cannot bypass the guard.
async function updateUserRoleHandler(req, res) {
  try {
    const { role } = req.body;
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    if (!["customer", "technician", "admin"].includes(role)) {
      return res.status(400).json({ message: "Invalid role." });
    }

    // An admin may never change their own role — the UI disables it, but the
    // API must enforce it too so a direct request cannot self-demote/promote.
    if (String(id) === String(req.user._id)) {
      return res.status(403).json({ message: "You cannot change your own role." });
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const updated = await users.findOne({ _id: new ObjectId(id) });
    res.status(200).json(updated);
  } catch (err) {
    console.error("Patch user role error:", err);
    res.status(500).json({ message: "Server error." });
  }
}

app.patch("/users/:id/role", verifyToken, verifyAdmin, updateUserRoleHandler);
app.patch("/admin/users/:id/role", verifyToken, verifyAdmin, updateUserRoleHandler);



app.get("/services/:id", optionalAuth, async (req, res) => {
  try {
    const { id } = req.params; // destructure from req.params, not req.params.id

    // Validate the id so an invalid string doesn't throw
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service id",
      });
    }

    const service = await services.findOne({ _id: new ObjectId(id) });

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    // Hide pending/rejected/unavailable services from public visitors.
    // Admins may read any service; technicians may read their own (so the
    // edit form still loads a pending listing).
    const role = req.user?.role;
    const ownsIt =
      role === "technician" &&
      String(service.technicianEmail || "").toLowerCase() ===
        String(req.user.email || "").toLowerCase();
    const publiclyVisible =
      service.approvalStatus === "approved" &&
      service.isAvailable !== false &&
      service.availableForBooking !== false;

    if (role !== "admin" && !ownsIt && !publiclyVisible) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    res.status(200).json(service);
  } catch (error) {
    console.error("Get service error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch service",
    });
  }
});

// Service Related API's
app.post("/services",verifyToken, verifyTechnician, async (req, res) => {
  try {
    const {
      title,
      category,
      description,
      basePrice,
      estimatedDuration,
      serviceArea,
      serviceMode,
      technicianName,
      technicianId,
      image,
      availableForBooking,
    } = req.body;

    // Required field validation
    if (
      !title?.trim() ||
      !category ||
      !description?.trim() ||
      basePrice === undefined ||
      !estimatedDuration ||
      !serviceArea?.trim() ||
      !serviceMode ||
      !technicianName?.trim() ||
      !technicianId
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide all required fields.",
      });
    }

    // Price validation
    const price = Number(basePrice);

    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({
        success: false,
        message: "Base price must be a valid positive number.",
      });
    }

    // Description validation
    if (description.trim().length < 30 || description.trim().length > 500) {
      return res.status(400).json({
        success: false,
        message: "Description must be between 30 and 500 characters.",
      });
    }

    // Service mode validation
    const validModes = ["Home Visit", "Shop Drop-off"];

    if (!validModes.includes(serviceMode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service mode.",
      });
    }

   const serviceData = {
  title: title.trim(),
  category,
  description: description.trim(),
  basePrice: price,
  estimatedDuration,
  serviceArea: serviceArea.trim(),
  serviceMode,
  technicianName: technicianName.trim(),
  technicianId,
  technicianEmail: req.user.email,
  image: image?.trim() || "",
  availableForBooking: availableForBooking ?? true,
  isAvailable: availableForBooking ?? true,

  approvalStatus: "pending",
  createdAt: new Date(),
};;

    const result = await services.insertOne(serviceData);

    res.status(201).json({
      success: true,
      message: "Service submitted successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Add service error:", error);

    res.status(500).json({
      success: false,
      message: "Something went wrong while adding the service.",
    });
  }
});


async function updateServiceHandler(req, res) {
  try {
    const { technicianId, ...updates } = req.body;
    const id = req.params.id || req.body.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service id." });
    }

    if (!technicianId) {
      return res.status(400).json({ message: "Technician id is required." });
    }

    // Find service owned by this technician (match by technicianId OR technicianEmail)
    const service = await services.findOne({
      _id: new ObjectId(id),
      $or: [
        { technicianId },
        { technicianId: String(req.user._id) },
        { technicianEmail: req.user.email },
      ],
    });

    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    const CONTENT_FIELDS = [
      "title",
      "category",
      "description",
      "basePrice",
      "estimatedDuration",
      "serviceArea",
      "serviceMode",
      "image",
    ];

    const isContentEdit = CONTENT_FIELDS.some(
      (field) => updates[field] !== undefined
    );

    const $set = { updatedAt: new Date() };

  
    if (isContentEdit) {
      const {
        title,
        category,
        description,
        basePrice,
        estimatedDuration,
        serviceArea,
        serviceMode,
        image,
      } = updates;

      if (
        !title?.trim() ||
        !category ||
        !description?.trim() ||
        basePrice === undefined ||
        !estimatedDuration ||
        !serviceArea?.trim() ||
        !serviceMode
      ) {
        return res.status(400).json({
          message: "Please provide all required fields.",
        });
      }

      const price = Number(basePrice);

      if (!Number.isFinite(price) || price <= 0) {
        return res
          .status(400)
          .json({ message: "Base price must be a valid positive number." });
      }

      if (description.trim().length < 30 || description.trim().length > 500) {
        return res.status(400).json({
          message: "Description must be between 30 and 500 characters.",
        });
      }

      const validModes = ["Home Visit", "Shop Drop-off"];

      if (!validModes.includes(serviceMode)) {
        return res.status(400).json({ message: "Invalid service mode." });
      }

      Object.assign($set, {
        title: title.trim(),
        category,
        description: description.trim(),
        basePrice: price,
        estimatedDuration,
        serviceArea: serviceArea.trim(),
        serviceMode,
        image: image?.trim() || "",
      });


      $set.approvalStatus = "pending";
    }


    if (updates.availableForBooking !== undefined) {
      if (typeof updates.availableForBooking !== "boolean") {
        return res
          .status(400)
          .json({ message: "availableForBooking must be true or false." });
      }

      $set.availableForBooking = updates.availableForBooking;
      $set.isAvailable = updates.availableForBooking;
    }


    if (Object.keys($set).length === 1) {
      return res.status(400).json({ message: "Nothing to update." });
    }

    // Backfill technicianEmail if missing (for older services)
    if (!service.technicianEmail && req.user.email) {
      $set.technicianEmail = req.user.email;
    }

    await services.updateOne({ _id: service._id }, { $set });

    res.status(200).json({ ...service, ...$set });
  } catch (error) {
    console.error("Update service error:", error);
    res.status(500).json({ message: "Server error." });
  }
}

app.patch("/services", verifyToken, verifyTechnician, updateServiceHandler);
app.patch("/services/:id", verifyToken, verifyTechnician, updateServiceHandler);


app.delete("/services/:id",verifyToken, verifyTechnician, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid service id." });
    }

    const { technicianId } = req.query;

    if (!technicianId) {
      return res.status(400).json({ message: "Technician id is required." });
    }

    // Find service owned by this technician (match by technicianId OR technicianEmail)
    const service = await services.findOne({
      _id: new ObjectId(req.params.id),
      $or: [
        { technicianId },
        { technicianId: String(req.user._id) },
        { technicianEmail: req.user.email },
      ],
    });

    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    await services.deleteOne({ _id: service._id });

    res.status(200).json({ success: true, message: "Service deleted." });
  } catch (error) {
    console.error("Delete service error:", error);
    res.status(500).json({ message: "Server error." });
  }
});

async function updateServiceApprovalHandler(req, res) {
  try {
    const { status } = req.body; // "approved" or "rejected"
    const { id } = req.params;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status." });
    }

    const result = await services.updateOne(
      { _id: new ObjectId(id) },
      { $set: { approvalStatus: status, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Service not found." });
    }

    res.status(200).json({ message: "Status updated successfully." });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
}

app.patch("/services/:id/approval", verifyToken, verifyAdmin, updateServiceApprovalHandler);
app.patch("/admin/services/:id/approval", verifyToken, verifyAdmin, updateServiceApprovalHandler);


// Update the signed-in user's own profile. Identity comes from the JWT only —
// there is no userId in the request, so one customer cannot edit another user.
app.patch("/users/profile", verifyToken, async (req, res) => {
  try {
    const allowed = ["name", "phone", "area", "bio", "image"];
    const updates = {};

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key] === null ? null : String(req.body[key]);
      }
    }

    if (Object.hasOwn(updates, "name") && !updates.name.trim()) {
      return res.status(400).json({ message: "Name cannot be empty." });
    }

    await users.updateOne(
      { _id: req.user._id },
      { $set: { ...updates, updatedAt: new Date() } }
    );

    const updated = await users.findOne({ _id: req.user._id });
    res.status(200).json(updated);
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ message: "Failed to update profile." });
  }
});

// Get all users — private admin data.
async function listUsersHandler(_req, res) {
  try {
    const data = await users.find().toArray();

    res.status(200).json(data);
  } catch (error) {
    console.error("Get users error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch users",
    });
  }
}

app.get("/users", verifyToken, verifyAdmin, listUsersHandler);
app.get("/admin/users", verifyToken, verifyAdmin, listUsersHandler);

//booking related api


// `forced` is "customer" or "technician" for the dedicated /my and
// /technician routes: those derive the identity from the JWT, never from a
// query parameter, so a user cannot read someone else's bookings by changing
// the URL. The generic /bookings route still supports admins listing any.
async function listBookingsHandler(req, res, forced) {
  try {
    let { email, technicianEmail } = req.query;
    if (forced === "customer") {
      email = req.user.email;
      technicianEmail = undefined;
    } else if (forced === "technician") {
      technicianEmail = req.user.email;
      email = undefined;
    }

    if (!email && !technicianEmail) {
      return res
        .status(400)
        .json({ message: "Either email or technicianEmail is required." });
    }

    // Callers may only list their own bookings (admins can list any).
    const callerEmail = String(req.user.email).toLowerCase();
    const requestedEmail = String(email || technicianEmail).toLowerCase();
    if (req.user.role !== "admin" && requestedEmail !== callerEmail) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const bookings = db.collection("bookings");

    // Escape for a case-insensitive anchored regex match (MongoDB text fields
    // are case-sensitive by default, so we match ignoring email casing).
    const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const ciMatch = (value) => ({
      $regex: `^${escapeRegex(value)}$`,
      $options: "i",
    });

    const rawEmail = email ? String(email) : undefined;
    const rawTechnicianEmail = technicianEmail ? String(technicianEmail) : undefined;

    // Resolve bookings whose technicianEmail is null by joining through the
    // service -> technician user record. Older bookings were saved without an
    // email when the service lacked technicianEmail/technicianId.
    let query;
    if (rawTechnicianEmail && !rawEmail) {
      // Find all services that belong to this technician, either by
      // technicianEmail or by technicianId matching the caller's user id.
      const techServices = await services
        .find({
          $or: [
            { technicianEmail: ciMatch(rawTechnicianEmail) },
            { technicianId: String(req.user._id) },
            { technicianId: req.user._id },
          ],
        })
        .project({ _id: 1 })
        .toArray();

      // serviceId in bookings is stored as a string, so convert to strings
      const techServiceIds = techServices.map((s) => String(s._id));

      query = {
        $or: [
          { technicianEmail: ciMatch(rawTechnicianEmail) },
          {
            technicianEmail: null,
            serviceId: { $in: techServiceIds },
          },
        ],
      };
    } else if (rawEmail) {
      query = { customerEmail: ciMatch(rawEmail) };
    } else {
      return res
        .status(400)
        .json({ message: "Either email or technicianEmail is required." });
    }

    const data = await bookings.find(query).sort({ createdAt: -1 }).toArray();

    // Backfill null technicianEmail on bookings belonging to this technician
    // so subsequent status updates (which key off technicianEmail) work.
    if (rawTechnicianEmail) {
      const callerLower = String(rawTechnicianEmail).toLowerCase();
      for (const b of data) {
        if (!b.technicianEmail && b.serviceId) {
          // serviceId in bookings is stored as a string, convert to ObjectId
          let svcId = b.serviceId;
          if (typeof svcId === "string" && ObjectId.isValid(svcId)) {
            svcId = new ObjectId(svcId);
          }
          const svc = await services.findOne({ _id: svcId }).project({
            technicianId: 1,
            technicianEmail: 1,
          });
          let resolvedEmail = svc?.technicianEmail;
          if (!resolvedEmail && svc?.technicianId) {
            // technicianId may be a string (better-auth) or ObjectId
            let tech = null;
            if (ObjectId.isValid(svc.technicianId)) {
              tech = await users
                .findOne({ _id: new ObjectId(svc.technicianId) })
                .project({ email: 1 });
            }
            if (!tech) {
              tech = await users
                .findOne({ _id: svc.technicianId })
                .project({ email: 1 });
            }
            resolvedEmail = tech?.email;
          }
          if (resolvedEmail && String(resolvedEmail).toLowerCase() === callerLower) {
            await bookings.updateOne(
              { _id: b._id },
              { $set: { technicianEmail: resolvedEmail } }
            );
            b.technicianEmail = resolvedEmail;
          }
        }
      }
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
}

app.get("/bookings", verifyToken, listBookingsHandler);
app.get(
  "/bookings/my",
  verifyToken,
  verifyCustomer,
  (req, res) => listBookingsHandler(req, res, "customer")
);
app.get(
  "/bookings/technician",
  verifyToken,
  verifyTechnician,
  (req, res) => listBookingsHandler(req, res, "technician")
);

app.get("/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  try {
   

    

    const data = await bookings
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(data);
  } catch (err) {
    console.error("Admin bookings error:", err);

    res.status(500).json({
      message: "Failed to fetch bookings.",
    });
  }
});



app.post("/bookings",verifyToken, verifyCustomer,async (req, res) => {
  try {
    const b = req.body;

    // Ownership is decided by the token, never by a client-supplied email.
    b.customerEmail = req.user.email;

    if (
      !b.serviceId ||
      !b.customerEmail ||
      !b.customerPhone ||
      !b.address ||
      !b.preferredDate ||
      !b.problemDescription?.trim() ||
      b.problemDescription.trim().length < 20
    ) {
      return res.status(400).json({ message: "Invalid or missing fields." });
    }

    if (!ObjectId.isValid(b.serviceId)) {
      return res.status(400).json({ message: "Invalid service id." });
    }

    const date = new Date(b.preferredDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (isNaN(date) || date < today) {
      return res.status(400).json({ message: "Invalid preferred date." });
    }

    const service = await db.collection("services").findOne({
      _id: new ObjectId(b.serviceId),
    });

    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    

    const duplicate = await bookings.findOne({
      serviceId: b.serviceId,
      customerEmail: b.customerEmail,
      status: { $in: ["requested", "accepted", "in-progress"] },
    });

    if (duplicate) {
      return res.status(409).json({
        message: "You already have an active request for this service.",
      });
    }

    // Older services were saved without technicianEmail - resolve it from the
    // technician's user record so the technician still receives the request.
    let technicianEmail = service.technicianEmail;
    
    // If no technicianEmail on service, try to resolve it from technicianId
    if (!technicianEmail && service.technicianId) {
      // technicianId may be a string (better-auth) or ObjectId
      let tech = null;
      if (ObjectId.isValid(service.technicianId)) {
        tech = await users.findOne({
          _id: new ObjectId(service.technicianId),
        });
      }
      if (!tech) {
        tech = await users.findOne({
          _id: service.technicianId,
        });
      }
      technicianEmail = tech?.email;
    }
    
    // Ensure we have a technicianEmail before creating the booking
    if (!technicianEmail) {
      return res.status(400).json({ 
        message: "Technician email is required to create a booking" 
      });
    }

    const result = await bookings.insertOne({
      serviceId: b.serviceId,
      serviceTitle: service.title,
      serviceImage: service.image,
      category: service.category,
      basePrice: service.basePrice,
      technicianName: service.technicianName,
      technicianEmail,
      customerName: b.customerName,
      customerEmail: b.customerEmail,
      customerPhone: b.customerPhone.trim(),
      address: b.address.trim(),
      preferredDate: date,
      problemDescription: b.problemDescription.trim(),
      status: "requested",
      finalAmount: service.basePrice,
      paymentStatus: "unpaid",
      createdAt: new Date(),
    });

    res.status(201).json({ bookingId: result.insertedId });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});


// A customer may only cancel their OWN booking. Identity comes from the JWT,
// so changing an email in the URL/body cannot target someone else's job.
app.patch("/bookings/:id/cancel", verifyToken, verifyCustomer, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid booking id." });
    }

    const booking = await bookings.findOne({
      _id: new ObjectId(req.params.id),
      customerEmail: ciExact(req.user.email),
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found." });
    }

    // Business rule: a customer may cancel ONLY while the job is requested.
    // Once the technician has accepted it, only the technician can move it.
    if (booking.status !== "requested") {
      return res.status(409).json({
        message: "Only a requested booking can be cancelled.",
      });
    }

    await bookings.updateOne(
      { _id: booking._id },
      { $set: { status: "cancelled", updatedAt: new Date() } }
    );

    res.status(200).json({ ...booking, status: "cancelled" });
  } catch (err) {
    console.error("Cancel booking error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Only the technician who OWNS the job can move it through the status pipeline.
// The caller is taken from the verified token — a body-supplied email is never
// trusted for identity (it is ignored entirely).
app.patch("/bookings/:id/status", verifyToken, verifyTechnician, async (req, res) => {
  try {
    const { status, finalAmount } = req.body;

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid booking id." });
    }

    const TECHNICIAN_STATUSES = ["accepted", "in-progress", "completed", "rejected"];
    if (!TECHNICIAN_STATUSES.includes(status)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const me = String(req.user.email).toLowerCase();

    // Normal case: the booking carries the technician's email.
    let booking = await bookings.findOne({
      _id: new ObjectId(req.params.id),
      technicianEmail: ciExact(req.user.email),
    });

    // Legacy case: technicianEmail is null — join through service -> technician.
    if (!booking) {
      const doc = await bookings.findOne({ _id: new ObjectId(req.params.id) });
      if (doc && !doc.technicianEmail && doc.serviceId) {
        let svcId = doc.serviceId;
        if (typeof svcId === "string" && ObjectId.isValid(svcId)) {
          svcId = new ObjectId(svcId);
        }
        const svc = await services.findOne({ _id: svcId });
        let techEmail = svc?.technicianEmail;

        if (!techEmail && svc?.technicianId) {
          let tech = null;
          if (ObjectId.isValid(svc.technicianId)) {
            tech = await users.findOne({ _id: new ObjectId(svc.technicianId) });
          }
          if (!tech) tech = await users.findOne({ _id: svc.technicianId });
          techEmail = tech?.email;
        }

        if (techEmail && String(techEmail).toLowerCase() === me) {
          booking = doc;
          await bookings.updateOne(
            { _id: doc._id },
            { $set: { technicianEmail: techEmail } }
          );
        }
      }
    }

    if (!booking) {
      return res.status(404).json({ message: "Booking not found." });
    }

    // One-way pipeline. Terminal states (completed / cancelled / rejected)
    // are locked, so a job can never be re-opened or "un-completed".
    const ALLOWED_TRANSITIONS = {
      requested: ["accepted", "rejected"],
      accepted: ["in-progress", "rejected"],
      "in-progress": ["completed", "rejected"],
      completed: [],
      cancelled: [],
      rejected: [],
    };

    const current = booking.status;
    if (!(ALLOWED_TRANSITIONS[current] ?? []).includes(status)) {
      return res.status(409).json({
        message: `Cannot move a ${current} booking to ${status}.`,
      });
    }

    if (status === "completed") {
      // Completing a job REQUIRES the technician to send the final amount.
      const amt = Number(finalAmount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({
          message: "A final amount greater than 0 is required to complete a job.",
        });
      }
    }

    await bookings.updateOne(
      { _id: booking._id },
      {
        $set: {
          status,
          ...(status === "completed" && { finalAmount: Number(finalAmount) }),
          updatedAt: new Date(),
        },
      }
    );

    res.status(200).json({ ...booking, status });
  } catch (err) {
    console.error("Patch booking status error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Technician corrects the final price of a completed, still-unpaid job.
app.patch(
  "/bookings/:id/final-amount",
  verifyToken,
  verifyTechnician,
  async (req, res) => {
    try {
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ message: "Invalid booking id." });
      }

      const amount = Number(req.body.finalAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res
          .status(400)
          .json({ message: "Final amount must be greater than 0." });
      }

      // Handle bookings with null technicianEmail by resolving from service
      let booking = await bookings.findOne({
        _id: new ObjectId(req.params.id),
        technicianEmail: req.user.email,
      });

      // If not found and technicianEmail is null, try to resolve via service
      if (!booking) {
        const bookingDoc = await bookings.findOne({
          _id: new ObjectId(req.params.id),
          projection: { technicianEmail: 1, serviceId: 1, status: 1, paymentStatus: 1 }
        });
        
        if (bookingDoc && !bookingDoc.technicianEmail && bookingDoc.serviceId) {
          const serviceDoc = await db.collection("services").findOne({
            _id: bookingDoc.serviceId
          });
          if (serviceDoc?.technicianId) {
            const tech = await users.findOne({
              _id: new ObjectId(serviceDoc.technicianId)
            });
            if (tech?.email && String(tech.email).toLowerCase() === String(req.user.email).toLowerCase()) {
              booking = bookingDoc;
            }
          }
        }
      }

      if (!booking) {
        return res.status(404).json({ message: "Booking not found." });
      }
      if (booking.status !== "completed") {
        return res
          .status(409)
          .json({ message: "Only a completed job's amount can be edited." });
      }
      if (booking.paymentStatus === "paid") {
        return res
          .status(409)
          .json({ message: "This job is already paid and can't be changed." });
      }

      await bookings.updateOne(
        { _id: booking._id },
        { $set: { finalAmount: amount, updatedAt: new Date() } }
      );

      res.status(200).json({ ...booking, finalAmount: amount });
    } catch (err) {
      console.error("Update final amount error:", err);
      res.status(500).json({ message: "Server error." });
    }
  }
);

// (The old DELETE /bookings/:id stub was removed — it had no auth and never
// sent a response, so it has been replaced by the protected cancel endpoint.)

//Payment related API's


// Create Stripe Checkout Session
app.post("/payments/create-checkout-session", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "Invalid booking ID" });
    }

    // Payment gate #1: only the booking's own customer can pay for it.
    const booking = await bookings.findOne({
      _id: new ObjectId(bookingId),
      customerEmail: ciExact(req.user.email),
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Pay-after-service: a job can only be paid for once the technician has
    // marked it completed. The UI hides Pay Now earlier, but enforce it here
    // so a direct API call cannot pay for a requested/accepted booking.
    if (booking.status !== "completed") {
      return res.status(400).json({
        message: "Payment is only available for completed jobs.",
      });
    }

    if (booking.paymentStatus === "paid" || booking.paidAt) {
      return res.status(400).json({ message: "Already paid" });
    }

    // The amount is ALWAYS derived from the stored job, never from the client.
    const amount = Number(booking.finalAmount ?? booking.basePrice);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "Invalid payment amount." });
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: booking.serviceTitle,
            description: `Service by ${booking.technicianName}`,
          },
          unit_amount: Math.round(amount * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
      // Stripe only creates a hosted receipt when it knows the receipt email.
      customer_email: booking.customerEmail,
      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/payment/cancel`,
      metadata: {
        bookingId: bookingId,
        customerEmail: booking.customerEmail,
      },
    });

    // Store the session ID for webhook reference
    await bookings.updateOne(
      { _id: booking._id },
      { $set: { stripeSessionId: session.id } }
    );

    res.json({ sessionId: session.id, url: session.url });
  } catch (err) {
    console.error("Create checkout session error:", err);
    res.status(500).json({ message: "Failed to create payment session" });
  }
});


// Settle a payment after the customer returns from Stripe Checkout.
// This is the browser-redirect path (the webhook is the server-side path);
// it is idempotent, so refreshing the success page never double-charges.
app.post("/payments/verify", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ message: "sessionId is required." });
    }

    // Retrieve the live Checkout Session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(200).json({ paid: false });
    }

    // The browser-redirect path must confirm this session belongs to the
    // signed-in customer. (The webhook path is Stripe-signed and needs no
    // such check.) Without this, anyone holding a session id could settle it.
    const sessionEmail = session.metadata?.customerEmail;
    if (
      !sessionEmail ||
      String(sessionEmail).toLowerCase() !== String(req.user.email).toLowerCase()
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const bookingId = session.metadata?.bookingId;

    if (!bookingId || !ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "No valid bookingId on session." });
    }

    // Idempotency: if this session already created a payment, don't re-settle.
    const existing = await payments.findOne({ stripeSessionId: session.id });
    if (existing) {
      const receiptUrl = await backfillPaymentReceipt(existing);
      return res.status(200).json({
        paid: true,
        alreadyPaid: true,
        amount: existing.amount,
        transactionId: existing.stripePaymentIntentId || undefined,
        serviceTitle: existing.serviceTitle,
        receiptUrl: receiptUrl || existing.receiptUrl || undefined,
      });
    }

    // Payment gate #2: the session must belong to this customer's completed
    // job. Re-check against the database, not just Stripe metadata.
    const booking = await bookings.findOne({
      _id: new ObjectId(bookingId),
      customerEmail: ciExact(req.user.email),
    });
    if (!booking) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (booking.status !== "completed") {
      return res.status(400).json({
        message: "Payment is only available for completed jobs.",
      });
    }

    const paymentData = {
      bookingId,
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || "",
      transactionId: session.payment_intent || "",
      customerName: booking.customerName,
      customerEmail: booking.customerEmail,
      technicianName: booking.technicianName,
      technicianEmail: booking.technicianEmail,
      serviceTitle: booking.serviceTitle,
      amount: (session.amount_total ?? 0) / 100,
      currency: session.currency || "usd",
      paymentStatus: "paid",
      paidAt: new Date(),
      createdAt: new Date(),
    };

    // Store the receipt URL at settlement time too. Without this, the browser
    // redirect path relied entirely on the on-demand fetch to fill it in.
    if (paymentData.stripePaymentIntentId) {
      paymentData.receiptUrl = await fetchReceiptUrl(
        paymentData.stripePaymentIntentId
      );
      paymentData.paymentMethod = await fetchPaymentMethod(
        paymentData.stripePaymentIntentId
      );
    }

    try {
      await payments.insertOne(paymentData);
    } catch (insertErr) {
      // The webhook settled this session first - report the stored payment.
      if (insertErr?.code === 11000) {
        const settled = await payments.findOne({ stripeSessionId: session.id });
        const receiptUrl = await backfillPaymentReceipt(settled);
        return res.status(200).json({
          paid: true,
          alreadyPaid: true,
          amount: settled?.amount ?? paymentData.amount,
          transactionId:
            settled?.stripePaymentIntentId ||
            paymentData.stripePaymentIntentId ||
            undefined,
          serviceTitle: settled?.serviceTitle ?? paymentData.serviceTitle,
          receiptUrl: receiptUrl || paymentData.receiptUrl || undefined,
        });
      }
      throw insertErr;
    }

    await bookings.updateOne(
      { _id: booking._id },
      {
        $set: {
          paymentStatus: "paid",
          paidAt: new Date(),
          stripeSessionId: session.id,
          stripePaymentIntentId: paymentData.stripePaymentIntentId,
          updatedAt: new Date(),
        },
      }
    );

    console.log("Payment settled via /payments/verify for booking:", bookingId);

    return res.status(200).json({
      paid: true,
      amount: paymentData.amount,
      transactionId: paymentData.stripePaymentIntentId,
      serviceTitle: paymentData.serviceTitle,
      receiptUrl: paymentData.receiptUrl || undefined,
    });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ message: "Failed to verify payment." });
  }
});


app.get("/payments",verifyToken, verifyCustomer, async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    // A customer may only read their own payments.
    if (String(email).toLowerCase() !== String(req.user.email).toLowerCase()) {
      return res.status(403).json({ message: "Forbidden" });
    }

    

    const docs = await bookings
      .find({ customerEmail: email, status: { $nin: ["cancelled", "rejected"] } })
      .sort({ createdAt: -1 })
      .toArray();

    // Pull the real payment intent IDs and receipt URLs from the payments collection
    const paymentRecords = await payments
      .find({ bookingId: { $in: docs.map((b) => String(b._id)) } })
      .toArray();
    // Prefer the settled record when more than one exists for a booking (an
    // old `pending` placeholder must never shadow the real Stripe payment).
    const settledRecords = paymentRecords
      .filter(
        (p) =>
          p.paymentStatus === "paid" ||
          p.paidAt ||
          p.stripePaymentIntentId
      )
      .sort(
        (a, b) =>
          Number(Boolean(b.paidAt || b.paymentStatus === "paid")) -
          Number(Boolean(a.paidAt || a.paymentStatus === "paid"))
      );

    const intentByBooking = new Map(
      settledRecords.map((p) => [p.bookingId, p.stripePaymentIntentId])
    );
    
    // Build receipt URL and payment method maps, fetching missing ones from Stripe on-demand
    const receiptByBooking = new Map();
    const paymentMethodByBooking = new Map();
    
    for (const p of settledRecords) {
      // Fetch receipt URL if missing
      if (p.receiptUrl) {
        receiptByBooking.set(p.bookingId, p.receiptUrl);
      } else if (p.stripePaymentIntentId) {
        const receiptUrl = await fetchReceiptUrl(p.stripePaymentIntentId);
        if (receiptUrl) {
          receiptByBooking.set(p.bookingId, receiptUrl);
          await payments.updateOne(
            { _id: p._id },
            { $set: { receiptUrl } }
          );
        }
      }
      
      // Fetch payment method if missing
      if (p.paymentMethod) {
        paymentMethodByBooking.set(p.bookingId, p.paymentMethod);
      } else if (p.stripePaymentIntentId) {
        const paymentMethod = await fetchPaymentMethod(p.stripePaymentIntentId);
        if (paymentMethod) {
          paymentMethodByBooking.set(p.bookingId, paymentMethod);
          await payments.updateOne(
            { _id: p._id },
            { $set: { paymentMethod } }
          );
        }
      }
    }

    const data = docs.map((b) => {
      const paid = b.paymentStatus === "paid";
      const id = String(b._id);

      return {
        _id: id,
        bookingId: id,
        customerEmail: b.customerEmail,
        serviceTitle: b.serviceTitle,
        technicianName: b.technicianName,
        amount: b.finalAmount ?? b.basePrice ?? 0,
        currency: "usd",
        status: paid ? "paid" : "pending",
      
        stripePaymentIntentId: paid
          ? intentByBooking.get(id) || b.stripePaymentIntentId || undefined
          : undefined,
        transactionId: paid
          ? intentByBooking.get(id) || b.stripePaymentIntentId || undefined
          : undefined,
        paymentMethod: paid ? paymentMethodByBooking.get(id) || undefined : undefined,
        receiptUrl: paid ? receiptByBooking.get(id) || undefined : undefined,
        jobStatus: b.status,
        completedAt:
          b.status === "completed" ? (b.updatedAt ?? b.createdAt) : undefined,
        createdAt: b.createdAt,
        paidAt: paid ? (b.updatedAt ?? b.createdAt) : undefined,
      };
    });

    res.status(200).json(data);
  } catch (err) {
    console.error("Get payments error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

app.get("/admin/payments",  verifyToken, verifyAdmin,
  async (req, res) => {
    try {
      const paymentDocs = await payments
        .find({})
        .sort({ paidAt: -1 })
        .toArray();

      // Fetch missing receipt URLs and payment methods from Stripe on-demand
      const data = await Promise.all(
        paymentDocs.map(async (payment) => {
          let receiptUrl = payment.receiptUrl;
          let paymentMethod = payment.paymentMethod;
          
          // If receipt URL is missing but we have a payment intent, try to fetch it
          if (!receiptUrl && payment.stripePaymentIntentId) {
            receiptUrl = await fetchReceiptUrl(payment.stripePaymentIntentId);
            
            // Save it to database for future use
            if (receiptUrl) {
              await payments.updateOne(
                { _id: payment._id },
                { $set: { receiptUrl } }
              );
            }
          }

          // If payment method is missing, try to fetch it from Stripe
          if (!paymentMethod && payment.stripePaymentIntentId) {
            paymentMethod = await fetchPaymentMethod(payment.stripePaymentIntentId);
            
            // Save it to database for future use
            if (paymentMethod) {
              await payments.updateOne(
                { _id: payment._id },
                { $set: { paymentMethod } }
              );
            }
          }

          return {
            _id: String(payment._id),

            bookingId: String(payment.bookingId || ""),

            customerName: payment.customerName || "",
            customerEmail: payment.customerEmail || "",

            technicianName: payment.technicianName || "",
            technicianEmail: payment.technicianEmail || "",

            serviceTitle: payment.serviceTitle || "",

            amount: Number(payment.amount || 0),
            currency: payment.currency || "usd",

            // Determine status: if paidAt exists or paymentStatus is "paid", it's paid
            status: payment.paymentStatus === "paid" || payment.paidAt ? "paid" : (payment.paymentStatus || "pending"),

            // Real Stripe Payment Intent ID
            stripePaymentIntentId: payment.stripePaymentIntentId || "",
            transactionId:
              payment.transactionId || payment.stripePaymentIntentId || "",

            // Real Checkout Session ID
            stripeSessionId: payment.stripeSessionId || "",

            // Payment method details
            paymentMethod: paymentMethod || undefined,

            paidAt: payment.paidAt || null,
            createdAt: payment.paidAt || payment.createdAt || null,

            // Return actual receipt URL
            receiptUrl: receiptUrl || null,
          };
        })
      );

      res.status(200).json({
        success: true,
        total: data.length,
        data,
      });

    } catch (error) {
      console.error("Admin payments error:", error);

      res.status(500).json({
        success: false,
        message: "Failed to fetch payment transactions.",
      });
    }
  }
);

// Endpoint to manually refresh/retry receipt URL for a specific payment
app.post("/admin/payments/:id/receipt", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid payment id." });
    }

    const payment = await payments.findOne({ _id: new ObjectId(id) });
    
    if (!payment) {
      return res.status(404).json({ message: "Payment not found." });
    }

    if (!payment.stripePaymentIntentId) {
      return res.status(400).json({ message: "No Stripe payment intent ID found." });
    }

    // Try to fetch receipt URL
    const receiptUrl = await fetchReceiptUrl(payment.stripePaymentIntentId);
    
    if (receiptUrl) {
      // Save to database
      await payments.updateOne(
        { _id: payment._id },
        { $set: { receiptUrl } }
      );
      
      return res.status(200).json({
        success: true,
        receiptUrl,
        message: "Receipt URL fetched successfully.",
      });
    } else {
      return res.status(404).json({
        success: false,
        message: "Receipt URL not available from Stripe yet.",
      });
    }

  } catch (error) {
    console.error("Refresh receipt error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to refresh receipt URL.",
    });
  }
});


app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});


export default app