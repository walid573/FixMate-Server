
import express from 'express';
import cors from 'cors';
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const app = express();
const port = process.env.PORT || 8000;

app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGODB_URL);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
    throw err;
  }
}

const connectClient = await connectToMongoDB();

const db = connectClient.db('fixmate');
const users = db.collection("users");
const services = db.collection("services");


app.get('/', (req, res) => {
  res.send(`Hello from Server`);
});


// Get all services
app.get('/feature-services', async (req, res) => {
  try {
    const data = await services.find().limit(6).toArray();
    res.status(200).send(data);
  } catch (err) {
    res.status(500).send({
      message: "Failed to fetch services",
      error: err.message
    });
  }
});
app.get('/services', async (req, res) => {
  try {
    const data = await services.find().toArray();
    res.status(200).send(data);
  } catch (err) {
    res.status(500).send({
      message: "Failed to fetch services",
      error: err.message
    });
  }
});


// Get all users
app.get('/users', async (req, res) => {
  try {
    const data = await users.find().toArray();
    res.status(200).send(data);
  } catch (err) {
    res.status(500).send({
      message: "Failed to fetch users",
      error: err.message
    });
  }
});


app.listen(port, () => {
  console.log(`server is running at http://localhost:${port}`);
});
