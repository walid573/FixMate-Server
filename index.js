import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const app = express();

const port = process.env.PORT || 8000;

app.use(express.json());

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

const users = db.collection("users");
const services = db.collection("services");
const bookings = db.collection("bookings")

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

// ---------------------------------------------------------------------------
// MOCK STRIPE DATA
//
// Stripe is not wired up yet, so the PaymentIntent id and card details below
// are DETERMINISTICALLY DERIVED from the booking id (same booking -> same
// values on every request). Replace these with the real Stripe values once
// the checkout flow exists — the response shape stays identical.
// ---------------------------------------------------------------------------
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function toB62(n, len) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += B62[n % 62];
    n = Math.floor(n / 62);
  }
  return s;
}

// "pi_3qX9_a1f2" style PaymentIntent id, stable per booking.
function mockPaymentIntentId(bookingId) {
  const h = fnv1a(bookingId);
  return `pi_${toB62(h, 4)}_${toB62(((h >>> 5) ^ 0x9e3779b9) >>> 0, 4)}`;
}

// { brand, last4 } card summary, stable per booking.
function mockPaymentMethod(bookingId) {
  const h = fnv1a(bookingId);
  const brands = ["visa", "mastercard", "amex", "visa"];
  return {
    brand: brands[h % brands.length],
    last4: String(1000 + ((h >>> 10) % 9000)),
  };
}

// Get payments for a customer.
//
// There is no `payments` collection yet (Stripe is not wired up), so payment
// records are DERIVED from the bookings collection:
//   - paymentStatus === "paid"  -> status "paid"
//   - otherwise                -> status "pending" (awaiting payment)
// Cancelled / rejected bookings are not payments, so they are excluded.
//
// `stripePaymentIntentId` and `paymentMethod` are MOCK values, returned ONLY
// for bookings that are actually paid — a pending payment has no card or
// PaymentIntent yet, so those fields come back undefined and the client
// renders "—" until the payment settles.
// `receiptUrl` stays empty until Stripe can issue real receipts.
//
// When Stripe is added later, switch this to read from a real `payments`
// collection — the response shape stays the same, so the client won't change.

app.get("/payments", async (req, res) => {
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
        // MOCK Stripe values — ONLY once the booking is actually paid.
        // A pending booking has no card or PaymentIntent yet, so it renders
        // "—" in the Method / Transaction ID columns until payment settles.
        stripePaymentIntentId: paid ? mockPaymentIntentId(id) : undefined,
        paymentMethod: paid ? mockPaymentMethod(id) : undefined,
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



// Start server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});