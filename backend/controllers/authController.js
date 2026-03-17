import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

import { createUser, findUserByEmail } from "../models/userModel.js";

export async function register(req,res){

const {email,password} = req.body;

const hashed = await bcrypt.hash(password,10);

const user = await createUser(email,hashed);

res.json(user);

}

export async function login(req,res){

const {email,password} = req.body;

const user = await findUserByEmail(email);

if(!user) return res.status(404).json({error:"user not found"});

const match = await bcrypt.compare(password,user.password);

if(!match) return res.status(401).json({error:"wrong password"});

const token = jwt.sign(
{id:user.id},
process.env.JWT_SECRET,
{expiresIn:"7d"}
);

res.json({token,user});

}
