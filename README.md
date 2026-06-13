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

Tokens can be provided via `.env` (`AGENT_TOKEN_BDI`, `AGENT_TOKEN_LLM`) or with the `--token=` flag.

Single Agent BDI:
```bash
npm start
# or with explicit token:
node --experimental-strip-types main.ts --token=YOUR_TOKEN
```

Single Agent with LLM (BDI + LLM interface):
```bash
npm run start:llm
# or with explicit token:
node --experimental-strip-types main.ts --use-llm --token=YOUR_TOKEN
```

Multi Agent mode (two terminals, BDI + LLM):
```bash
# Terminal 1 — BDI agent (reads AGENT_TOKEN_BDI from .env)
npm run start:bdi
# Terminal 2 — LLM agent (reads AGENT_TOKEN_LLM from .env)
npm run start:llm
```

## Run Tests

### LLM unit tests

Configure your `.env` first, then from `Agent/`:

```bash
npm test                  # run all LLM tests
npm run test:skip-live    # skip tests that require a live API call
npm run test:verbose      # verbose output
```

### Single-agent benchmark

Runs the BDI agent on every matching map for 5 minutes each and writes results to `results/benchmark_results.csv`.

```bash
# all maps (default: 26c1_* pattern)
bash benchmark_single_agent.sh
```

### Multi-agent benchmark

Runs the BDI agent and the LLM agent simultaneously on every map and writes per-agent results to `results/multi_agent_benchmark.csv`.

```bash
# all maps
bash benchmark_multi_agent.sh
```
