import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";

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

// Add a new service
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

// Start server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});