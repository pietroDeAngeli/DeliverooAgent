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

You can see the world using [http://localhost:8080/](http://localhost:8080/)

Create your own credentials there.

### Setup
```bash
git clone https://github.com/pietroDeAngeli/Deliveroo_Agent
cd Deliveroo_Agent
npm install
```
Modify the `.env.example` file with the required fields and rename it to `.env`

#### Fast Downward installation (PDDL)
If you want your agent to use PDDL you can clone the `downward` repository and build it with the following commands:

```bash
cd pddl
git clone https://github.com/aibasel/downward.git
cd downward
python3 build.py
cd ../..
``` 

### Running the Agent

You can run the agent in different setups:

Single Agent BDI:
```bash
node --experimental-strip-types main.ts
```

Single Agent with LLM (BDI + LLM interface):
```bash
node --experimental-strip-types main.ts --use-llm
```

Multi Agent mode (two terminals, BDI + LLM):
```bash
# Terminal 1
node --experimental-strip-types main.ts
# Terminal 2
node --experimental-strip-types main.ts --use-llm
```
(Not implemented yet)

## Run Tests

Single Agent BDI as:
```bash
TODO
``` 

Multi Agent mode (BDI + LLM)
```bash
TODO
``` 

To run LLM tests you need to configure your `.env` first. Then from the directory `Agent/` run:

```bash
node --experimental-strip-types tests/llm_tests.ts
```
