// FORCE BACKEND LOGIN (no localStorage)

const API = "https://gpu-ai.onrender.com/api";

window.registerUser = async function(email,password){
  const r = await fetch(API + "/register",{
    method:"POST",
    headers:{ "Content-Type":"application/json"},
    body: JSON.stringify({email,password})
  });
  return r.json();
}

window.loginUser = async function(email,password){
  const r = await fetch(API + "/login",{
    method:"POST",
    headers:{ "Content-Type":"application/json"},
    body: JSON.stringify({email,password})
  });
  const data = await r.json();

  if(data.token){
    localStorage.setItem("token",data.token);
  }

  return data;
}

window.getProfile = async function(){
  const token = localStorage.getItem("token");

  const r = await fetch(API + "/me",{
    headers:{
      Authorization:"Bearer "+token
    }
  });

  return r.json();
}
