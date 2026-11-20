import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";

const app = express();

const port = process.env.PORT || 8000;

// ---------------------------------------------------------------------------
// Body parsing.
//
// The Stripe webhook verifies its signature against the RAW request bytes,
// so that one path skips the JSON parser and uses express.raw() inside the
// route instead. Everything else gets the usual JSON body.
// ---------------------------------------------------------------------------
const jsonParser = express.json();

app.use((req, res, next) => {
  if (req.path === "/payments/webhook") return next();
  return jsonParser(req, res, next);
});

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST", "PATCH", "DELETE"],
  })
);

// MongoDB connection
const mongoUrl = process.env.MONGODB_URL;

if (!mongoUrl) {
  throw new Error("MONGODB_URL is missing from environment variables");
}

const client = new MongoClient(mongoUrl);

export async function connectToMongoDB() {
  try {
    await client.connect();

    console.log("Successfully connected to MongoDB!");

    return client;
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

const connectClient = await connectToMongoDB();

const db = connectClient.db("fixmate");

// ---------------------------------------------------------------------------
// Stripe client
//
// The secret key comes from .env. It is a restricted key (rk_test_...) scoped
// to payment_intents:write — the only permission the checkout flow needs.
// ---------------------------------------------------------------------------
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error("STRIPE_SECRET_KEY is missing from .env");
}

const stripe = new Stripe(stripeSecretKey);

const users = db.collection("users");
const services = db.collection("services");
const bookings = db.collection("bookings");

// ---------------------------------------------------------------------------
// Database indexes
//
// Indexes live in code so they travel with the deploy instead of being hand-made
// in the Atlas UI and silently lost on re-provision. createIndexes is
// idempotent — re-running it on an existing index is a no-op — so it is safe to
// call on every startup. This is also what creates the `payments` collection,
// which otherwise never materialises because nothing writes to it.
// ---------------------------------------------------------------------------
async function ensureIndexes() {
  await db.collection("payments").createIndexes([
    {
      key: { bookingId: 1 },
      name: "payments_bookingId_uidx",
      unique: true,
    },
    {
      key: { customerEmail: 1, createdAt: -1 },
      name: "payments_customerEmail_createdAt_idx",
    },
    {
      key: { status: 1 },
      name: "payments_status_idx",
    },
    {
      // Unique on the intent id, but only for real intents — a pending
      // payment has no intent yet, so the index is partial and those docs
      // don't block the constraint.
      key: { stripePaymentIntentId: 1 },
      name: "payments_stripePaymentIntentId_uidx",
      unique: true,
      partialFilterExpression: { stripePaymentIntentId: { $type: "string" } },
    },
  ]);

  await db.collection("bookings").createIndexes([
    { key: { customerEmail: 1, createdAt: -1 }, name: "bookings_customerEmail_createdAt_idx" },
    { key: { technicianEmail: 1, createdAt: -1 }, name: "bookings_technicianEmail_createdAt_idx" },
    { key: { status: 1 }, name: "bookings_status_idx" },
  ]);

  await db.collection("services").createIndexes([
    { key: { technicianId: 1 }, name: "services_technicianId_idx" },
    { key: { approvalStatus: 1, isAvailable: 1 }, name: "services_approval_available_idx" },
    { key: { category: 1 }, name: "services_category_idx" },
  ]);

  await db.collection("users").createIndexes([
    { key: { role: 1 }, name: "users_role_idx" },
  ]);
}

await ensureIndexes();

const payments = db.collection("payments");

// ---------------------------------------------------------------------------
// Backfill
//
// A payment record is created for every booking the moment the booking is
// created. Bookings made before this change have no payment row, so on startup
// we create the missing ones (idempotent — the unique index on bookingId
// means re-running it is safe). Cancelled/rejected bookings never need a
// payment, so they are skipped.
// ---------------------------------------------------------------------------
async function backfillPayments() {
  const existing = await payments.find({}, { projection: { bookingId: 1 } }).toArray();
  const existingIds = new Set(existing.map((p) => p.bookingId));

  const bookingsToPay = await bookings
    .find({
      _id: { $nin: Array.from(existingIds).map((id) => new ObjectId(id)) },
      status: { $nin: ["cancelled", "rejected"] },
    })
    .toArray();

  if (bookingsToPay.length === 0) return;

  const docs = bookingsToPay.map((b) => ({
    bookingId: String(b._id),
    customerEmail: b.customerEmail,
    serviceTitle: b.serviceTitle,
    technicianName: b.technicianName,
    amount: b.finalAmount ?? b.basePrice ?? 0,
    currency: "usd",
    status: "pending",
    stripePaymentIntentId: undefined,
    paymentMethod: undefined,
    receiptUrl: undefined,
    jobStatus: b.status,
    completedAt: b.status === "completed" ? (b.updatedAt ?? b.createdAt) : undefined,
    createdAt: b.createdAt ?? new Date(),
    paidAt: undefined,
  }));

  try {
    await payments.insertMany(docs, { ordered: false });
    console.log(`Backfilled ${docs.length} payment record(s) for existing bookings.`);
  } catch (err) {
    // A race between two startups would trip the unique index; that's fine —
    // the records already exist, so nothing to do.
    if (err.code !== 11000) throw err;
  }
}

await backfillPayments();

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



// Get all services
app.get("/services", async (req, res) => {
  try {
    const { technicianEmail, technicianId } = req.query;
    const filter = {};
    if (technicianEmail) filter.technicianEmail = technicianEmail;
    if (technicianId) filter.technicianId = technicianId;
    const data = await services
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();
    res.status(200).json(data);
  } catch (error) {
    console.error("Get services error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch services",
    });
  }
});


app.get("/services/:id", async (req, res) => {
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
app.post("/services", async (req, res) => {
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
  image: image?.trim() || "",

  // Keep both availability fields synchronized
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


app.patch("/services", async (req, res) => {
  try {
    const { id, technicianId, ...updates } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service id." });
    }

    if (!technicianId) {
      return res.status(400).json({ message: "Technician id is required." });
    }

    const service = await services.findOne({
      _id: new ObjectId(id),
      technicianId,
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
      // The service details page reads isAvailable, public pages read
      // availableForBooking - keep them in step so one toggle does both.
      $set.isAvailable = updates.availableForBooking;
    }

    // Nothing recognised in the payload.
    if (Object.keys($set).length === 1) {
      return res.status(400).json({ message: "Nothing to update." });
    }

    await services.updateOne({ _id: service._id }, { $set });

    res.status(200).json({ ...service, ...$set });
  } catch (error) {
    console.error("Update service error:", error);
    res.status(500).json({ message: "Server error." });
  }
});


app.delete("/services/:id", async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid service id." });
    }

    const { technicianId } = req.query;

    if (!technicianId) {
      return res.status(400).json({ message: "Technician id is required." });
    }

    const service = await services.findOne({
      _id: new ObjectId(req.params.id),
      technicianId,
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

// ---------------------------------------------------------------------------
// Approve / reject a service (ADMIN-side).
//
// PATCH /services/:id/approval with { status: "approved" | "rejected" }.
// ---------------------------------------------------------------------------
app.patch("/services/:id/approval", async (req, res) => {
  try {
    const { status } = req.body;
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service id." });
    }

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

    const updated = await services.findOne({ _id: new ObjectId(id) });
    res.status(200).json(updated);
  } catch (err) {
    console.error("Patch service approval error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Get all users
app.get("/users", async (req, res) => {
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
});

// ---------------------------------------------------------------------------
// Update a user's role (admin only).
//
// PATCH /users/:id/role with { role } — enforces a valid role and returns
// the updated user document.
// ---------------------------------------------------------------------------
app.patch("/users/:id/role", async (req, res) => {
  try {
    const { role } = req.body;
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    if (!["customer", "technician", "admin"].includes(role)) {
      return res.status(400).json({ message: "Invalid role." });
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
});

//booking related api


app.get("/bookings", async (req, res) => {
  try {
    const { email, technicianEmail } = req.query;

    if (!email && !technicianEmail) {
      return res
        .status(400)
        .json({ message: "Either email or technicianEmail is required." });
    }

    const bookings = db.collection("bookings");

    // Customers ask for their own bookings; technicians ask for the ones
    // assigned to them. The two never overlap, so one query is enough.
    const query = email
      ? { customerEmail: email }
      : { technicianEmail };

    const data = await bookings.find(query).sort({ createdAt: -1 }).toArray();

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

// ---------------------------------------------------------------------------
// All bookings (ADMIN view).
//
// GET /bookings/all — returns every booking on the platform, sorted newest
// first. No filter is applied because admins need the full picture.
// ---------------------------------------------------------------------------
app.get("/bookings/all", async (req, res) => {
  try {
    const bookings = db.collection("bookings");
    const data = await bookings.find().sort({ createdAt: -1 }).toArray();
    res.status(200).json(data);
  } catch (err) {
    console.error("Get all bookings error:", err);
    res.status(500).json({ message: "Server error." });
  }
});




app.post("/bookings", async (req, res) => {
  try {
    const b = req.body;

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

    // The services collection stores `technicianId` but not the email, so
    // resolve the technician's email from the users collection. Without this
    // every booking lands with technicianEmail: null and the technician
    // dashboard (which filters on technicianEmail) shows nothing.
    let technicianEmail = service.technicianEmail;
    let technicianName = service.technicianName;
    if (service.technicianId) {
      const techUser = await db.collection("users").findOne({
        _id: new ObjectId(service.technicianId),
      });
      if (techUser) {
        technicianEmail = techUser.email;
        technicianName = techUser.name;
      }
    }

    

    const duplicate = await bookings.findOne({
      serviceId: b.serviceId,
      customerEmail: b.customerEmail,
      status: { $in: ["requested", "accepted", "in-progress"] },
    });

    if (duplicate) {
      return res.status(409).json({ message: "Active booking already exists." });
    }

    const result = await bookings.insertOne({
      serviceId: b.serviceId,
      serviceTitle: service.title,
      serviceImage: service.image,
      category: service.category,
      basePrice: service.basePrice,
      technicianName: technicianName,
      technicianEmail: technicianEmail,
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

    // A booking always has a matching payment record. The payment starts
    // pending and is flipped to paid by POST /payments once checkout
    // completes. The unique index on payments.bookingId guarantees the
    // 1:1 relation and makes the backfill on startup idempotent.
    await payments.insertOne({
      bookingId: String(result.insertedId),
      customerEmail: b.customerEmail,
      serviceTitle: service.title,
      technicianName: technicianName,
      amount: service.basePrice,
      currency: "usd",
      status: "pending",
      stripePaymentIntentId: undefined,
      paymentMethod: undefined,
      receiptUrl: undefined,
      jobStatus: "requested",
      completedAt: undefined,
      createdAt: new Date(),
      paidAt: undefined,
    });

    res.status(201).json({ bookingId: result.insertedId });
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});


app.patch("/bookings/:id/status", async (req, res) => {
  try {
    const { status, customerEmail, technicianEmail, finalAmount } = req.body;

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid booking id." });
    }

    if (
      ![
        "requested",
        "accepted",
        "in-progress",
        "completed",
        "cancelled",
        "rejected",
      ].includes(status)
    ) {
      return res.status(400).json({ message: "Invalid status." });
    }

    if (!customerEmail && !technicianEmail) {
      return res
        .status(400)
        .json({ message: "Either customerEmail or technicianEmail is required." });
    }

    // `finalAmount` must be a real, positive price whenever it is provided.
    // A $0 booking is impossible downstream — Stripe cannot charge zero, and
    // the checkout would silently fall back to basePrice — so reject it here
    // with a clear message instead.
    if (finalAmount !== undefined) {
      const amount = Number(finalAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res
          .status(400)
          .json({ message: "Final amount must be greater than $0." });
      }
    }

    // Ownership check — the caller must be one of the two parties.
    const ownerQuery = {};
    if (customerEmail) ownerQuery.customerEmail = customerEmail;
    if (technicianEmail) ownerQuery.technicianEmail = technicianEmail;

    const booking = await bookings.findOne({
      _id: new ObjectId(req.params.id),
      ...ownerQuery,
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found." });
    }

    // ---- Transition guard -------------------------------------------------
    // Each status can only move forward along the agreed path; terminal states
    // are locked. This is what stops a completed job being "un-completed".
    const ALLOWED_TRANSITIONS = {
      requested: ["accepted", "rejected", "cancelled"],
      accepted: ["in-progress", "rejected", "cancelled"],
      "in-progress": ["completed", "rejected", "cancelled"],
      completed: [],
      cancelled: [],
      rejected: [],
    };

    const current = booking.status;
    const allowed = ALLOWED_TRANSITIONS[current] ?? [];

    if (!allowed.includes(status)) {
      return res.status(409).json({
        message: `Cannot move a ${current} booking to ${status}.`,
      });
    }

    await bookings.updateOne(
      { _id: booking._id },
      {
        $set: {
          status,
          // `finalAmount` is OPTIONAL — only meaningful when completing a job
          // (the technician sets the final price). Ignored for every other
          // transition so the existing basePrice is preserved. Validated
          // above: only a finite number > 0 can reach this point.
          ...(finalAmount !== undefined && { finalAmount: Number(finalAmount) }),
          updatedAt: new Date(),
        },
      }
    );

    res.status(200).json({ ...booking, status, ...(finalAmount !== undefined ? { finalAmount: Number(finalAmount) } : {}) });
  } catch (err) {
    console.error("Patch booking status error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ---------------------------------------------------------------------------
// Edit the final amount of an ALREADY-COMPLETED job.
//
// PATCH /bookings/:id/final-amount  { technicianEmail, finalAmount }
//
// The technician owns the price, but only until the customer pays:
//   - caller must be the booking's technician
//   - booking must be "completed" (the price only exists then)
//   - booking must NOT be paid yet (a paid price is locked forever)
//   - finalAmount must be > 0 — a $0 job cannot exist: Stripe cannot
//     charge zero, and the checkout would fall back to basePrice
//
// This is also how a mistyped 0 gets corrected: the value can be edited
// here until the customer settles the payment.
// ---------------------------------------------------------------------------
app.patch("/bookings/:id/final-amount", async (req, res) => {
  try {
    const { technicianEmail, finalAmount } = req.body;

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid booking id." });
    }

    if (!technicianEmail) {
      return res.status(400).json({ message: "technicianEmail is required." });
    }

    const amount = Number(finalAmount);
    if (finalAmount === undefined || !Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ message: "Final amount must be greater than $0." });
    }

    const booking = await bookings.findOne({
      _id: new ObjectId(req.params.id),
      technicianEmail,
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found." });
    }

    if (booking.status !== "completed") {
      return res.status(409).json({
        message: "The final amount can only be edited after the job is completed.",
      });
    }

    if (booking.paymentStatus === "paid") {
      return res.status(409).json({
        message: "This job is already paid — the amount is locked.",
      });
    }

    await bookings.updateOne(
      { _id: booking._id },
      { $set: { finalAmount: amount, updatedAt: new Date() } }
    );

    res.status(200).json({ ...booking, finalAmount: amount });
  } catch (err) {
    console.error("Edit final amount error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

app.delete('/bookings/:id', async(req,res)=>{

})

//Payment related API's

// ---------------------------------------------------------------------------
// Stripe Checkout — create a session for ONE completed booking.
//
// POST /payments/checkout-session  { bookingId, customerEmail }
//
// Pay-after-service model: only a booking the technician marked "completed"
// can be paid, and only once. The AMOUNT ALWAYS comes from the booking
// document in the database — never from the client. bookingId and
// customerEmail travel in the session metadata so the verify step can
// settle the right records afterwards.
// ---------------------------------------------------------------------------
app.post("/payments/checkout-session", async (req, res) => {
  try {
    const { bookingId, customerEmail } = req.body;

    if (!bookingId || !ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "Invalid booking id." });
    }
    if (!customerEmail) {
      return res.status(400).json({ message: "customerEmail is required." });
    }

    const booking = await bookings.findOne({ _id: new ObjectId(bookingId) });
    if (!booking || booking.customerEmail !== customerEmail) {
      return res.status(404).json({ message: "Booking not found." });
    }
    if (booking.status !== "completed") {
      return res
        .status(409)
        .json({ message: "You can only pay after the job is completed." });
    }
    if (booking.paymentStatus === "paid") {
      return res
        .status(409)
        .json({ message: "This booking is already paid." });
    }

    // Amount from the DB: the final price the technician set, falling back to
    // the quoted base price when finalAmount is missing or zero.
    const amount =
      Number(booking.finalAmount) > 0
        ? Number(booking.finalAmount)
        : Number(booking.basePrice);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res
        .status(400)
        .json({ message: "This booking has no payable amount." });
    }

    // The customer-facing origin (CLIENT_URL falls back to the dev server).
    const appUrl = process.env.CLIENT_URL || "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: booking.serviceTitle },
            unit_amount: Math.round(amount * 100), // Stripe charges cents
          },
          quantity: 1,
        },
      ],
      metadata: {
        bookingId: String(booking._id),
        customerEmail,
      },
      success_url: `${appUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/payment/cancel`,
    });

    res.status(200).json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Create checkout session error:", err);
    res.status(500).json({ message: "Could not start checkout." });
  }
});

// ---------------------------------------------------------------------------
// Settle a paid Checkout Session — THE single write path for payments.
//
// Idempotent by construction, so it is safe from BOTH the success-page
// verify and the webhook (they often fire within milliseconds of each
// other):
//   1. unpaid / foreign session  -> { paid: false }, nothing is written
//   2. payment row already "paid"-> returns the existing row, no second save
//   3. otherwise                 -> upsert the payment row + flip booking
// The unique index on payments.bookingId means even two CONCURRENT calls
// cannot insert a duplicate: the loser gets E11000 and simply re-reads the
// row the winner wrote.
// ---------------------------------------------------------------------------
async function settlePaidSession(session) {
  if (session.payment_status !== "paid") {
    return { paid: false };
  }

  const bookingId = session.metadata?.bookingId;
  if (!bookingId || !ObjectId.isValid(bookingId)) {
    // Not a session created by this app (e.g. a Stripe CLI trigger fixture).
    return { paid: false };
  }

  // Already settled? Return the existing row — never save the same payment
  // twice (success page + webhook, or Stripe retrying the webhook).
  const existing = await payments.findOne({ bookingId });
  if (existing && existing.status === "paid") {
    return {
      paid: true,
      alreadyPaid: true,
      amount: existing.amount,
      transactionId: existing.stripePaymentIntentId,
      serviceTitle: existing.serviceTitle,
    };
  }

  // The session must carry a real positive amount. A malformed payload —
  // e.g. a hand-crafted webhook test event with payment_status "paid" but
  // no amount_total — would otherwise write NaN into the payment row and
  // crash every page that renders it.
  const amount = Number(session.amount_total) / 100;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { paid: false };
  }

  // Real card + receipt details off the PaymentIntent's charge.
  // Best effort — the settlement never fails over these.
  const intentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
  const transactionId = intentId || session.id;

  let paymentMethod;
  let receiptUrl;
  try {
    let intent =
      typeof session.payment_intent === "object" ? session.payment_intent : null;
    if (!intent && intentId) {
      intent = await stripe.paymentIntents.retrieve(intentId);
    }
    const chargeId = intent?.latest_charge;
    if (chargeId) {
      const charge =
        typeof chargeId === "string"
          ? await stripe.charges.retrieve(chargeId)
          : chargeId;
      const card = charge.payment_method_details?.card;
      if (card) {
        paymentMethod = { brand: card.brand, last4: card.last4 };
      }
      receiptUrl = charge.receipt_url ?? undefined;
    }
  } catch {
    // Card / receipt are nice-to-have — never fail the settlement over them.
  }

  const now = new Date();

  try {
    await payments.updateOne(
      { bookingId },
      {
        $set: {
          status: "paid",
          amount,
          stripePaymentIntentId: transactionId,
          paymentMethod,
          receiptUrl,
          stripeCheckoutSessionId: session.id,
          paidAt: now,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    // Duplicate key = a concurrent verify/webhook won the race with an
    // identical write. Fall through and read its result.
    if (err?.code !== 11000) throw err;
  }

  await bookings.updateOne(
    { _id: new ObjectId(bookingId), paymentStatus: { $ne: "paid" } },
    { $set: { paymentStatus: "paid", updatedAt: now } }
  );

  const saved = await payments.findOne({ bookingId });
  return {
    paid: true,
    alreadyPaid: false,
    amount: saved?.amount ?? amount,
    transactionId: saved?.stripePaymentIntentId ?? transactionId,
    serviceTitle: saved?.serviceTitle,
  };
}

// ---------------------------------------------------------------------------
// Stripe Checkout — verify and settle a payment.
//
// POST /payments/verify  { sessionId, customerEmail }
//
// Called by the success page via the protected /api/payments/verify
// handler. Ownership is checked here; the save runs through the shared
// settlePaidSession(), so this route and the webhook can never double-save
// the same payment.
// ---------------------------------------------------------------------------
app.post("/payments/verify", async (req, res) => {
  try {
    const { sessionId, customerEmail } = req.body;

    if (!sessionId || !customerEmail) {
      return res
        .status(400)
        .json({ message: "sessionId and customerEmail are required." });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent"],
    });

    if (session.payment_status !== "paid") {
      return res.status(200).json({ paid: false });
    }

    // Ownership: the session must have been created FOR this customer.
    if (session.metadata?.customerEmail !== customerEmail) {
      return res
        .status(403)
        .json({ message: "This payment does not belong to you." });
    }

    const result = await settlePaidSession(session);
    res.status(200).json(result);
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({ message: "Could not verify payment." });
  }
});

// ---------------------------------------------------------------------------
// Stripe webhook (Challenge 4) — POST /payments/webhook
//
// Stripe calls this directly (no browser session), so the route verifies
// the stripe-signature header against STRIPE_WEBHOOK_SECRET using the RAW
// body. The body reaches here unparsed because the global JSON parser
// skips this path (see the middleware at the top of this file).
//
// Both this webhook and the success-page verify run settlePaidSession(),
// which saves a payment AT MOST ONCE — whichever arrives second just
// re-reads the row the first one wrote.
//
// Local development:
//   stripe listen --forward-to localhost:8000/payments/webhook
// then paste the whsec_... it prints into .env as STRIPE_WEBHOOK_SECRET.
// ---------------------------------------------------------------------------
app.post(
  "/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error("STRIPE_WEBHOOK_SECRET is missing from .env");
      return res
        .status(500)
        .json({ message: "Webhook secret not configured." });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, // raw Buffer — required for signature verification
        req.headers["stripe-signature"],
        webhookSecret
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        if (session.payment_status === "paid") {
          const result = await settlePaidSession(session);
          console.log(
            `Webhook session ${session.id}:`,
            result.paid
              ? result.alreadyPaid
                ? "already paid (no double save)"
                : "payment saved"
              : "ignored (not our session)"
          );
        }
      }

      res.status(200).json({ received: true });
    } catch (err) {
      console.error("Webhook handling error:", err);
      // 500 makes Stripe retry; settlePaidSession is idempotent, so a
      // retry after a partial failure is safe.
      res.status(500).json({ message: "Webhook handler failed." });
    }
  }
);

// ---------------------------------------------------------------------------
// Shared aggregation: real `payments` rows joined to their booking.
//   - paid rows keep the amount actually charged (payments.amount)
//   - pending rows show the booking's current finalAmount
//   - jobStatus / completedAt always come from the LIVE booking
// Cancelled / rejected bookings are not payments, so they are excluded.
// ---------------------------------------------------------------------------
async function paymentsAggregate(match = {}) {
  return payments
    .aggregate([
      { $match: match },
      {
        $lookup: {
          from: "bookings",
          let: { bid: "$bookingId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$_id", { $toObjectId: "$$bid" }] },
              },
            },
            {
              $project: {
                customerName: 1,
                technicianEmail: 1,
                status: 1,
                finalAmount: 1,
                updatedAt: 1,
                createdAt: 1,
              },
            },
          ],
          as: "booking",
        },
      },
      { $unwind: "$booking" },
      { $match: { "booking.status": { $nin: ["cancelled", "rejected"] } } },
      { $sort: { paidAt: -1, createdAt: -1 } },
      {
        $project: {
          bookingId: 1,
          customerName: "$booking.customerName",
          customerEmail: 1,
          serviceTitle: 1,
          technicianName: 1,
          technicianEmail: "$booking.technicianEmail",
          amount: {
            $cond: [
              { $eq: ["$status", "paid"] },
              "$amount",
              { $ifNull: ["$booking.finalAmount", 0] },
            ],
          },
          currency: 1,
          status: 1,
          stripePaymentIntentId: 1,
          paymentMethod: 1,
          receiptUrl: 1,
          jobStatus: "$booking.status",
          completedAt: {
            $cond: [
              { $eq: ["$booking.status", "completed"] },
              { $ifNull: ["$booking.updatedAt", "$booking.createdAt"] },
              null,
            ],
          },
          createdAt: 1,
          paidAt: 1,
        },
      },
    ])
    .toArray();
}

// Get payments for a customer (REAL data from the `payments` collection).
app.get("/payments", async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    const data = await paymentsAggregate({ customerEmail: email });
    res.status(200).json(data);
  } catch (err) {
    console.error("Get payments error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// ---------------------------------------------------------------------------
// All payments (ADMIN view).
//
// GET /payments/all — every payment on the platform, newest first.
// ---------------------------------------------------------------------------
app.get("/payments/all", async (req, res) => {
  try {
    const data = await paymentsAggregate();
    res.status(200).json(data);
  } catch (err) {
    console.error("Get all payments error:", err);
    res.status(500).json({ message: "Server error." });
  }
});



// Start server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});