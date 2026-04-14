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

### Setup
```bash
git clone https://github.com/pietroDeAngeli/Deliveroo_Agent
cd Deliveroo_Agent
npm run setup
```
Create a `.env` with the following fields
```bash 
HOST=YOUR_HOST_NAME (e.g. http://localhost:8080)
TOKEN=YOUR_TOKEN
```

### Running the Agent

This project is written in TypeScript and uses ES Modules. We have provided npm scripts to handle the compilation and execution automatically.

To compile and run the agent in one command:
```bash
npm start
```

#### For active development (Watch Mode):
If you are modifying the code, you can run the development script. This keeps the compiler open whilst you modify the programs:
```bash
npm run dev
```

# Note
Note that the BDI loop is not implemented yet, this is just an initial commit. 



