import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";
import { jwtVerify } from "jose";


const app = express();

const port = process.env.PORT || 8000;

// Stripe configuration
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!stripeSecretKey) {
  throw new Error("STRIPE_SECRET_KEY is missing");
}

if (!webhookSecret) {
  throw new Error("STRIPE_WEBHOOK_SECRET is missing");
}

const stripe = new Stripe(stripeSecretKey);



app.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      console.log("Stripe event received:", event.type);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const bookingId = session.metadata?.bookingId;

        if (!bookingId || !ObjectId.isValid(bookingId)) {
          console.error("No valid bookingId in session metadata");
          return res.status(200).json({ received: true });
        }

        // Check if already processed (idempotency)
        const existingPayment = await payments.findOne({ stripeSessionId: session.id });
        if (existingPayment) {
          console.log("Payment already processed for session:", session.id);
          return res.status(200).json({ received: true });
        }

        // Get booking
        const booking = await bookings.findOne({ _id: new ObjectId(bookingId) });
        if (!booking) {
          console.error("Booking not found:", bookingId);
          return res.status(200).json({ received: true });
        }

        // Create payment record
        const paymentData = {
          bookingId: bookingId,
          stripeSessionId: session.id,
          stripePaymentIntentId: session.payment_intent,
          customerName: booking.customerName,
          customerEmail: booking.customerEmail,
          technicianName: booking.technicianName,
          technicianEmail: booking.technicianEmail,
          serviceTitle: booking.serviceTitle,
          amount: session.amount_total / 100,
          currency: session.currency,
          paymentStatus: "paid",
          paidAt: new Date(),
          createdAt: new Date(),
        };

        await payments.insertOne(paymentData);

        // Update booking payment status
        await bookings.updateOne(
          { _id: booking._id },
          {
            $set: {
              paymentStatus: "paid",
              paidAt: new Date(),
              stripeSessionId: session.id
            }
          }
        );

        console.log("Payment processed successfully for booking:", bookingId);
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("Webhook processing error:", error);
      return res.status(500).json({ message: "Webhook processing failed" });
    }
  }
);

// Normal JSON middleware AFTER Stripe webhook
app.use(express.json());

app.use(
  cors({
     origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
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

const users = db.collection("users");
const services = db.collection("services");
const bookings = db.collection("bookings")
const payments = db.collection("payments");





// 1. Verify authentication token
//
// The Next.js better-auth config signs the JWT with HS256 using the shared
// JWT_SECRET (see src/lib/auth.ts). We must verify with the SAME algorithm and
// secret — verifying an HS256 token against a remote JWKS (RS256) always fails
// with 401, which is what starved every protected endpoint of data.
const AUTH_URL = process.env.AUTH_URL;
if (!AUTH_URL) throw new Error("AUTH_URL is missing from .env");

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error("JWT_SECRET is missing from .env");

const jwtKey = new TextEncoder().encode(jwtSecret);

const verifyToken = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { payload } = await jwtVerify(header.split(" ")[1], jwtKey, {
      issuer: AUTH_URL,
      audience: AUTH_URL,
    });

    // Take the role from the DB, not the token, so role changes apply instantly
    const user = await users.findOne({ email: payload.email });
    if (!user) return res.status(401).json({ message: "Unauthorized" });

    req.user = user;
    next();
  } catch {
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



// Get all services
app.get("/services", async (req, res) => {
  try {
    const data = await services
      .find()
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

// Update a user's role (admin only).
app.patch("/users/:id/role",verifyToken, verifyAdmin,  async (req, res) => {
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


app.patch("/services",verifyToken, verifyTechnician, async (req, res) => {
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
      $set.isAvailable = updates.availableForBooking;
    }


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


app.delete("/services/:id",verifyToken, verifyTechnician, async (req, res) => {
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

app.patch("/services/:id/approval", verifyToken, verifyAdmin, async (req, res) => {
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

//booking related api


app.get("/bookings",verifyToken, async (req, res) => {
  try {
    const { email, technicianEmail } = req.query;

    if (!email && !technicianEmail) {
      return res
        .status(400)
        .json({ message: "Either email or technicianEmail is required." });
    }

    const bookings = db.collection("bookings");
    const query = email
      ? { customerEmail: email }
      : { technicianEmail };

    const data = await bookings.find(query).sort({ createdAt: -1 }).toArray();

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ message: "Server error." });
  }
});

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
      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
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


app.patch("/bookings/:id/status",verifyToken, async (req, res) => {
  try {
    const { status, customerEmail, technicianEmail } = req.body;

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
          // transition so the existing basePrice is preserved.
          ...(finalAmount !== undefined && { finalAmount }),
          updatedAt: new Date(),
        },
      }
    );

    res.status(200).json({ ...booking, status, ...(finalAmount !== undefined ? { finalAmount } : {}) });
  } catch (err) {
    console.error("Patch booking status error:", err);
    res.status(500).json({ message: "Server error." });
  }
});

app.delete('/bookings/:id', async(req,res)=>{

})

//Payment related API's


// Create Stripe Checkout Session
app.post("/payments/create-checkout-session", verifyToken, verifyCustomer, async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "Invalid booking ID" });
    }

    const booking = await bookings.findOne({
      _id: new ObjectId(bookingId),
      customerEmail: req.user.email
    });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.paymentStatus === "paid") {
      return res.status(400).json({ message: "Already paid" });
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: booking.serviceTitle,
            description: `Service by ${booking.technicianName}`,
          },
          unit_amount: Math.round((booking.finalAmount || booking.basePrice) * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
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

    const bookingId = session.metadata?.bookingId;

    if (!bookingId || !ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "No valid bookingId on session." });
    }

    // Idempotency: if this session already created a payment, don't re-settle.
    const existing = await payments.findOne({ stripeSessionId: session.id });
    if (existing) {
      return res.status(200).json({
        paid: true,
        alreadyPaid: true,
        amount: existing.amount,
        transactionId: existing.stripePaymentIntentId || undefined,
        serviceTitle: existing.serviceTitle,
      });
    }

    const booking = await bookings.findOne({ _id: new ObjectId(bookingId) });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found." });
    }

    const paymentData = {
      bookingId,
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || "",
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

    await payments.insertOne(paymentData);

    await bookings.updateOne(
      { _id: booking._id },
      {
        $set: {
          paymentStatus: "paid",
          paidAt: new Date(),
          stripeSessionId: session.id,
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

    

    const docs = await bookings
      .find({ customerEmail: email, status: { $nin: ["cancelled", "rejected"] } })
      .sort({ createdAt: -1 })
      .toArray();

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
      
        stripePaymentIntentId: paid ? (b.stripePaymentIntentId || undefined) : undefined,
        paymentMethod: undefined,
        receiptUrl: undefined,
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

app.get(
  "/admin/payments",
  verifyToken, verifyAdmin,
  async (req, res) => {
    try {
      const paymentDocs = await payments
        .find({})
        .sort({ paidAt: -1 })
        .toArray();

      const data = paymentDocs.map((payment) => ({
        _id: String(payment._id),

        bookingId: String(payment.bookingId || ""),

        customerName: payment.customerName || "",
        customerEmail: payment.customerEmail || "",

        technicianName: payment.technicianName || "",
        technicianEmail: payment.technicianEmail || "",

        serviceTitle: payment.serviceTitle || "",

        amount: Number(payment.amount || 0),
        currency: payment.currency || "usd",

        // Frontend-compatible status
        status: payment.paymentStatus || "pending",

        // Real Stripe Payment Intent ID
        stripePaymentIntentId: payment.transactionId || "",

        // Real Checkout Session ID
        stripeSessionId: payment.stripeSessionId || "",

        paidAt: payment.paidAt || null,
        createdAt: payment.paidAt || null,

        // These aren't stored in your current payment schema
        paymentMethod: undefined,
        receiptUrl: undefined,
      }));

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


app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});


export default app