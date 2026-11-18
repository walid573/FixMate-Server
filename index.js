import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import { MongoClient } from 'mongodb';



const app = express()
const port = process.env.NEXT_PUBLIC_URL || 8000

app.use(express.json())
app.use(cors())


const client = new MongoClient(process.env.MONGODB_URL);
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectClient = await connectToMongoDB();
const db = connectClient.db('fixmate')
const users = db.collection("user")



app.get('/',(req,res)=>{
    res.send(`Hello from Server`)
})




app.listen(port, ()=>{
    console.log(`server is running at ${port}`);
    
})