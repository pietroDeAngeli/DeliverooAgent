
class Agent {
    id = undefined;
    //name = undefined;
    x = undefined;
    y = undefined;
    //score = undefined;
    //penalty = undefined;

    constructor(agent) {
        this.id = agent.id;
        //this.name = agent.name;
        this.x = agent.x;
        this.y = agent.y;
        //this.score = agent.score;
        //this.penalty = agent.penalty;
    }
}

class OpponentAgent extends Agent {
    timestamp = undefined;
    direction = undefined;

    constructor(agent, timestamp) {
        super(agent);
        this.timestamp = timestamp;
        this.direction = null;
    }

}

export { Agent, OpponentAgent };