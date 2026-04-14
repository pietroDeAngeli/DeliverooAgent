# Deliveroo Agent


## Installation
You need to connect to a Deliveroo server. If you want to run it locally move to the next section, otherwise skip it.

### Server download and run
To run the server you can create a new directory
```bash 
git clone https://github.com/unitn-ASA/Deliveroo.js.git
cd Deliveroo.js
npm run build
npm start
```

You can see the the world using [http://localhost:8080/](http://localhost:8080/)

And creating yourself the credentials. 

### Agent download and run
```bash
git clone https://github.com/pietroDeAngeli/Deliveroo_Agent
cd Deliveroo_Agent
npm init
npm install @unitn-asa/deliveroo-js-sdk
npm install dotenv
```
Create a `.env` with the following fields
```bash 
HOST=YOUR_HOST_NAME (e.g. http://localhost:8080)
TOKEN=YOUR_TOKEN
```

Run the following commands:
```bash 
node main.js
```

# Note
Note that the BDI loop is not implemented yet, this is just an initial commit. 



