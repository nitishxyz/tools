#!/usr/bin/env bun
import { Command } from "commander";
import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import Dockerode from "dockerode";
import chalk from "chalk";

// Initialize Docker client
const docker = new Dockerode();

// Define the data directory for persistent storage
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "/tmp";
const DATA_DIR = path.join(HOME_DIR, ".pgdocker");
const INSTANCES_FILE = path.join(DATA_DIR, "instances.json");

// Ensure data directory exists
fs.ensureDirSync(DATA_DIR);

// Initialize instances file if it doesn't exist
if (!fs.existsSync(INSTANCES_FILE)) {
  fs.writeJSONSync(INSTANCES_FILE, { instances: [] }, { spaces: 2 });
}

// Define PostgreSQL instance type
interface PostgresInstance {
  id: string;
  name: string;
  port: number;
  version: string;
  dataPath: string;
  status: "running" | "stopped" | "unknown";
  createdAt: string;
  connectionString: string;
}

// Function to load instances from file
function loadInstances(): PostgresInstance[] {
  try {
    const data = fs.readJSONSync(INSTANCES_FILE);
    return data.instances || [];
  } catch (error) {
    console.error("Error loading instances:", error);
    return [];
  }
}

// Function to save instances to file
function saveInstances(instances: PostgresInstance[]): void {
  try {
    fs.writeJSONSync(INSTANCES_FILE, { instances }, { spaces: 2 });
  } catch (error) {
    console.error("Error saving instances:", error);
  }
}

// Add this at the top of your file
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Function to create a new PostgreSQL instance
async function createInstance(
  name: string,
  port: number,
  version: string
): Promise<void> {
  try {
    // Create data directory for this instance
    const instanceDataPath = path.join(DATA_DIR, "data", name);
    fs.ensureDirSync(instanceDataPath);

    const imageName = `postgres:${version}`;
    console.log(chalk.blue(`Pulling PostgreSQL image ${imageName}...`));

    // Pull the image first
    await new Promise<void>((resolve, reject) => {
      docker.pull(imageName, (err: any, stream: any) => {
        if (err) {
          return reject(err);
        }

        // Track progress
        let lastStatus = "";
        let downloadedLayers = new Set();
        let totalLayers = new Set();
        let spinnerIndex = 0;
        let spinnerInterval: NodeJS.Timer;

        // Start spinner
        spinnerInterval = setInterval(() => {
          spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
          if (lastStatus) {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            process.stdout.write(
              `${spinnerFrames[spinnerIndex]} ${lastStatus}`
            );
          }
        }, 80);

        docker.modem.followProgress(
          stream,
          (err: any) => {
            if (err) {
              clearInterval(spinnerInterval);
              return reject(err);
            }
            // Clear the spinner and move to a new line
            clearInterval(spinnerInterval);
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            console.log(chalk.green("✓ Image pull complete!"));
            resolve();
          },
          (progress: any) => {
            if (progress.id) {
              totalLayers.add(progress.id);

              if (
                progress.status === "Download complete" ||
                progress.status === "Pull complete"
              ) {
                downloadedLayers.add(progress.id);
              }
            }

            // Create a status message
            const progressPercent =
              totalLayers.size > 0
                ? Math.round((downloadedLayers.size / totalLayers.size) * 100)
                : 0;

            // Format the status message
            let detail = "";
            if (
              progress.progressDetail &&
              progress.progressDetail.current &&
              progress.progressDetail.total
            ) {
              const current = (
                progress.progressDetail.current /
                1024 /
                1024
              ).toFixed(1);
              const total = (
                progress.progressDetail.total /
                1024 /
                1024
              ).toFixed(1);
              detail = `${current}MB/${total}MB`;
            }

            const statusMessage = `${
              progress.status || "Processing"
            } | Progress: ${progressPercent}% | Layers: ${
              downloadedLayers.size
            }/${totalLayers.size} ${detail ? "| " + detail : ""}`;

            // Update the status message (will be displayed by the spinner interval)
            lastStatus = statusMessage;
          }
        );
      });
    });

    console.log(chalk.blue("Creating PostgreSQL container..."));

    // Create and start the container
    const container = await docker.createContainer({
     Image: imageName,
     name: `pgdocker-${name}`,
     ExposedPorts: {
       "5432/tcp": {},
     },
     HostConfig: {
       PortBindings: {
         "5432/tcp": [{ HostPort: `${port}` }],
       },
        Binds: [`${instanceDataPath}:/var/lib/postgresql/data/pgdata`],
     },
     Env: [
       "POSTGRES_PASSWORD=postgres",
       "POSTGRES_USER=postgres",
       "POSTGRES_DB=postgres",
        "PGDATA=/var/lib/postgresql/data/pgdata",
     ],
   });

    await container.start();

    // Save instance information
    const instances = loadInstances();
    instances.push({
      id: container.id,
      name,
      port,
      version,
      dataPath: instanceDataPath,
      status: "running",
      createdAt: new Date().toISOString(),
      connectionString: `postgres://postgres:postgres@localhost:${port}/postgres`,
    });
    saveInstances(instances);

    console.log(
      chalk.green(
        `PostgreSQL instance "${name}" created and started on port ${port}`
      )
    );
    console.log(chalk.yellow("Connection details:"));
    console.log(`  Host: localhost`);
    console.log(`  Port: ${port}`);
    console.log(`  User: postgres`);
    console.log(`  Password: postgres`);
    console.log(`  Database: postgres`);
    console.log(
      chalk.cyan(
        `  Connection string: postgres://postgres:postgres@localhost:${port}/postgres`
      )
    );
  } catch (error) {
    console.error(chalk.red("Error creating PostgreSQL instance:"), error);
  }
}

// Function to list all instances
async function listInstances(): Promise<void> {
  try {
    const instances = loadInstances();

    if (instances.length === 0) {
      console.log(chalk.yellow("No PostgreSQL instances found."));
      return;
    }

    // Update status for each instance
    for (const instance of instances) {
      try {
        const container = docker.getContainer(`pgdocker-${instance.name}`);
        const info = await container.inspect();
        instance.status = info.State.Running ? "running" : "stopped";

        // Ensure connection string exists (for backward compatibility with existing instances)
        if (!instance.connectionString) {
          instance.connectionString = `postgres://postgres:postgres@localhost:${instance.port}/postgres`;
        }
      } catch (error) {
        instance.status = "unknown";
      }
    }

    // Save updated statuses
    saveInstances(instances);

    console.log(chalk.blue("PostgreSQL Instances:"));
    instances.forEach((instance) => {
      const statusColor =
        instance.status === "running" ? chalk.green : chalk.red;
      console.log(`- ${instance.name} (${instance.version})`);
      console.log(`  Port: ${instance.port}`);
      console.log(`  Status: ${statusColor(instance.status)}`);
      console.log(`  Data path: ${instance.dataPath}`);
      console.log(
        `  Created: ${new Date(instance.createdAt).toLocaleString()}`
      );
      if (instance.status === "running") {
        console.log(
          chalk.cyan(`  Connection string: ${instance.connectionString}`)
        );
      }
      console.log();
    });
  } catch (error) {
    console.error(chalk.red("Error listing PostgreSQL instances:"), error);
  }
}

// Function to start an instance
async function startInstance(name: string): Promise<void> {
  try {
    const instances = loadInstances();
    const instance = instances.find((i) => i.name === name);

    if (!instance) {
      console.log(chalk.red(`Instance "${name}" not found.`));
      return;
    }

    const container = docker.getContainer(`pgdocker-${name}`);
    await container.start();

    // Update instance status
    instance.status = "running";
    saveInstances(instances);

    console.log(chalk.green(`PostgreSQL instance "${name}" started.`));
  } catch (error) {
    console.error(
      chalk.red(`Error starting PostgreSQL instance "${name}":`),
      error
    );
  }
}

// Function to stop an instance
async function stopInstance(name: string): Promise<void> {
  try {
    const instances = loadInstances();
    const instance = instances.find((i) => i.name === name);

    if (!instance) {
      console.log(chalk.red(`Instance "${name}" not found.`));
      return;
    }

    const container = docker.getContainer(`pgdocker-${name}`);
    await container.stop();

    // Update instance status
    instance.status = "stopped";
    saveInstances(instances);

    console.log(chalk.yellow(`PostgreSQL instance "${name}" stopped.`));
  } catch (error) {
    console.error(
      chalk.red(`Error stopping PostgreSQL instance "${name}":`),
      error
    );
  }
}

// Function to remove an instance
async function removeInstance(name: string, keepData: boolean): Promise<void> {
  try {
    const instances = loadInstances();
    const instanceIndex = instances.findIndex((i) => i.name === name);

    if (instanceIndex === -1) {
      console.log(chalk.red(`Instance "${name}" not found.`));
      return;
    }

    const instance = instances[instanceIndex];

    try {
      const container = docker.getContainer(`pgdocker-${name}`);
      await container.stop().catch(() => {}); // Ignore if already stopped
      await container.remove();
    } catch (error) {
      console.log(
        chalk.yellow(`Container for "${name}" not found or already removed.`)
      );
    }

    // Remove data directory if requested
    if (!keepData) {
      try {
        fs.removeSync(instance.dataPath);
        console.log(chalk.yellow(`Data directory for "${name}" removed.`));
      } catch (error) {
        console.error(
          chalk.red(`Error removing data directory for "${name}":`),
          error
        );
      }
    } else {
      console.log(
        chalk.blue(
          `Data directory for "${name}" preserved at ${instance.dataPath}`
        )
      );
    }

    // Remove from instances list
    instances.splice(instanceIndex, 1);
    saveInstances(instances);

    console.log(chalk.green(`PostgreSQL instance "${name}" removed.`));
  } catch (error) {
    console.error(
      chalk.red(`Error removing PostgreSQL instance "${name}":`),
      error
    );
  }
}

// Interactive mode
async function interactiveMode(): Promise<void> {
  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "What would you like to do?",
      choices: [
        { name: "Create a new PostgreSQL instance", value: "create" },
        { name: "List all PostgreSQL instances", value: "list" },
        { name: "Start a PostgreSQL instance", value: "start" },
        { name: "Stop a PostgreSQL instance", value: "stop" },
        { name: "Remove a PostgreSQL instance", value: "remove" },
        { name: "Exit", value: "exit" },
      ],
    },
  ]);

  if (action === "exit") {
    return;
  }

  if (action === "create") {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Enter a name for the PostgreSQL instance:",
        validate: (input) =>
          input.trim() !== "" ? true : "Name cannot be empty",
      },
      {
        type: "input",
        name: "port",
        message: "Enter the port to expose PostgreSQL on:",
        default: "5432",
        validate: (input) =>
          /^\d+$/.test(input) ? true : "Port must be a number",
      },
      {
        type: "list",
        name: "version",
        message: "Select PostgreSQL version:",
        choices: [
          "latest",
          "17",
          "16",
          "15",
          "14",
          "13",
          "12",
          "11",
          "10",
          "9.6",
        ],
      },
    ]);

    await createInstance(answers.name, parseInt(answers.port), answers.version);
  } else if (action === "list") {
    await listInstances();
  } else if (action === "start" || action === "stop" || action === "remove") {
    const instances = loadInstances();

    if (instances.length === 0) {
      console.log(chalk.yellow("No PostgreSQL instances found."));
      return;
    }

    const { name } = await inquirer.prompt([
      {
        type: "list",
        name: "name",
        message: `Select a PostgreSQL instance to ${action}:`,
        choices: instances.map((i) => ({
          name: `${i.name} (${i.version}) - ${i.status}`,
          value: i.name,
        })),
      },
    ]);

    if (action === "start") {
      await startInstance(name);
    } else if (action === "stop") {
      await stopInstance(name);
    } else if (action === "remove") {
      const { confirm, keepData } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: `Are you sure you want to remove "${name}"?`,
          default: false,
        },
        {
          type: "confirm",
          name: "keepData",
          message: "Do you want to keep the data directory?",
          default: true,
          when: (answers) => answers.confirm,
        },
      ]);

      if (confirm) {
        await removeInstance(name, keepData);
      }
    }
  }

  // Continue interactive mode
  await interactiveMode();
}

// Create CLI program
const program = new Command();

program
  .name("pgdocker")
  .description("CLI tool to manage PostgreSQL instances with Docker")
  .version("1.0.0");

program
  .command("create")
  .description("Create a new PostgreSQL instance")
  .option("-n, --name <name>", "Name for the PostgreSQL instance")
  .option("-p, --port <port>", "Port to expose PostgreSQL on", "5432")
  .option("-v, --version <version>", "PostgreSQL version", "16")
  .action(async (options) => {
    if (!options.name) {
      console.error(chalk.red("Error: Name is required"));
      process.exit(1);
    }
    await createInstance(options.name, parseInt(options.port), options.version);
  });

program
  .command("list")
  .description("List all PostgreSQL instances")
  .action(listInstances);

program
  .command("start")
  .description("Start a PostgreSQL instance")
  .argument("<name>", "Name of the PostgreSQL instance")
  .action(startInstance);

program
  .command("stop")
  .description("Stop a PostgreSQL instance")
  .argument("<name>", "Name of the PostgreSQL instance")
  .action(stopInstance);

program
  .command("remove")
  .description("Remove a PostgreSQL instance")
  .argument("<name>", "Name of the PostgreSQL instance")
  .option("-k, --keep-data", "Keep the data directory", false)
  .action((name, options) => removeInstance(name, options.keepData));

program
  .command("interactive")
  .description("Start interactive mode")
  .action(interactiveMode);

// Default to interactive mode if no command is provided
if (process.argv.length <= 2) {
  interactiveMode().catch(console.error);
} else {
  program.parse(process.argv);
}
