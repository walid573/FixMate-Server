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
        availableForBooking: true,
      })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

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
      availableForBooking: availableForBooking ?? true,
      approvalStatus: "pending",
      createdAt: new Date(),
    };

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

app.patch("/services", async(req,res)=>{
  
})




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
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    const bookings = db.collection("bookings");

    const data = await bookings
      .find({ customerEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

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

app.patch("/bookings/:id/status", async(req,res)=>{

})

app.delete('/bookings/:id', async(req,res)=>{

})

//Payment related API's

// Get payments for a customer.
//
// There is no `payments` collection yet (Stripe is not wired up), so payment
// records are DERIVED from the bookings collection:
//   - paymentStatus === "paid"  -> status "paid"
//   - otherwise                -> status "pending" (awaiting payment)
// Cancelled / rejected bookings are not payments, so they are excluded.
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

      return {
        _id: String(b._id),
        bookingId: String(b._id),
        customerEmail: b.customerEmail,
        serviceTitle: b.serviceTitle,
        technicianName: b.technicianName,
        amount: b.finalAmount ?? b.basePrice ?? 0,
        currency: "usd",
        status: paid ? "paid" : "pending",
        // No Stripe yet — these fill in once payments are wired up.
        paymentMethod: undefined,
        stripePaymentIntentId: undefined,
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