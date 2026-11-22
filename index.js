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

        const paymentData = {
          bookingId: String(booking._id),
          stripeSessionId: session.id,
          stripePaymentIntentId:
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

        // Idempotent payment insertion
        try {
          await payments.updateOne(
            { stripeSessionId: session.id },
            { $setOnInsert: paymentData },
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
    const { technicianEmail, technicianId } = req.query;
    const query = {};
    
    // Case-insensitive email matching
    if (technicianEmail) {
      const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      query.technicianEmail = {
        $regex: `^${escapeRegex(technicianEmail)}$`,
        $options: "i",
      };
    }
    if (technicianId) query.technicianId = technicianId;

    const data = await services
      .find(query)
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


app.patch("/services",verifyToken, verifyTechnician, async (req, res) => {
  try {
    const { id, technicianId, ...updates } = req.body;

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
      return res.status(409).json({ message: "Active booking already exists." });
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


app.patch("/bookings/:id/status",verifyToken, async (req, res) => {
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

    // The caller must really be the party they claim to be.
    const me = String(req.user.email).toLowerCase();
    if (
      (customerEmail && String(customerEmail).toLowerCase() !== me) ||
      (technicianEmail && String(technicianEmail).toLowerCase() !== me)
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Technicians move jobs forward; customers can only cancel their own.
    const TECHNICIAN_STATUSES = ["accepted", "in-progress", "completed", "rejected"];
    if (
      technicianEmail
        ? !TECHNICIAN_STATUSES.includes(status)
        : status !== "cancelled"
    ) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (finalAmount !== undefined) {
      const amt = Number(finalAmount);
      if (!Number.isFinite(amt) || amt <= 0) {
        return res
          .status(400)
          .json({ message: "Final amount must be greater than 0." });
      }
    }

    // Ownership check — the caller must be one of the two parties.
    // For technicians, we need to handle the case where booking.technicianEmail is null
    // by resolving it from the service's technicianId
    let finalTechnicianEmail = technicianEmail;
    if (technicianEmail) {
      // First check if the booking actually has this technicianEmail or null
      const bookingDoc = await bookings.findOne({
        _id: new ObjectId(req.params.id),
        projection: { technicianEmail: 1, serviceId: 1 }
      });
      
      if (bookingDoc) {
        if (!bookingDoc.technicianEmail && bookingDoc.serviceId) {
          // Booking has null technicianEmail - resolve from service
          // serviceId in bookings is stored as a string, convert to ObjectId
          let svcId = bookingDoc.serviceId;
          if (typeof svcId === "string" && ObjectId.isValid(svcId)) {
            svcId = new ObjectId(svcId);
          }
          const serviceDoc = await db.collection("services").findOne({
            _id: svcId
          });
          if (serviceDoc?.technicianId) {
            // technicianId may be a string (better-auth) or ObjectId
            let tech = null;
            if (ObjectId.isValid(serviceDoc.technicianId)) {
              tech = await users.findOne({
                _id: new ObjectId(serviceDoc.technicianId)
              });
            }
            if (!tech) {
              tech = await users.findOne({
                _id: serviceDoc.technicianId
              });
            }
            if (tech?.email && String(tech.email).toLowerCase() === me) {
              finalTechnicianEmail = tech.email;
            }
          }
        }
      }
    }

    const ownerQuery = {};
    if (customerEmail) ownerQuery.customerEmail = customerEmail;
    if (finalTechnicianEmail) ownerQuery.technicianEmail = finalTechnicianEmail;

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
          ...(technicianEmail &&
            status === "completed" &&
            finalAmount !== undefined && { finalAmount: Number(finalAmount) }),
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

    try {
      await payments.insertOne(paymentData);
    } catch (insertErr) {
      // The webhook settled this session first - report the stored payment.
      if (insertErr?.code === 11000) {
        const settled = await payments.findOne({ stripeSessionId: session.id });
        return res.status(200).json({
          paid: true,
          alreadyPaid: true,
          amount: settled?.amount ?? paymentData.amount,
          transactionId:
            settled?.stripePaymentIntentId ||
            paymentData.stripePaymentIntentId ||
            undefined,
          serviceTitle: settled?.serviceTitle ?? paymentData.serviceTitle,
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

    // Pull the real payment intent IDs from the payments collection
    const paymentRecords = await payments
      .find({ bookingId: { $in: docs.map((b) => String(b._id)) } })
      .toArray();
    const intentByBooking = new Map(
      paymentRecords.map((p) => [p.bookingId, p.stripePaymentIntentId])
    );

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

app.get("/admin/payments",  verifyToken, verifyAdmin,
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
        stripePaymentIntentId: payment.stripePaymentIntentId || "",

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