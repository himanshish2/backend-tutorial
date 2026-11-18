// Run with: node test-api.js
// Your server must already be running (npm run dev) in another terminal.

const BASE = "http://localhost:5000";

// Random email each run so registration never conflicts
const email = `test${Date.now()}@gmail.com`;
const password = "123456";

let token = "";
let postId = "";
let failed = 0;

async function call(label, method, path, body, expectedStatus, useToken = true) {
    const headers = { "Content-Type": "application/json" };
    if (useToken && token) headers.Authorization = `Bearer ${token}`;

    let res, data;
    try {
        res = await fetch(BASE + path, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined
        });
        data = await res.json().catch(() => ({}));
    } catch (err) {
        console.log(`FAIL  ${label} -> cannot reach server (is it running?)`);
        process.exit(1);
    }

    const ok = res.status === expectedStatus;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}  (got ${res.status}, expected ${expectedStatus})`);
    if (!ok) console.log("      ", JSON.stringify(data));
    return data;
}

async function run() {
    console.log("Testing", BASE, "\n");

    await call("Register user", "POST", "/api/users/register",
        { name: "Test User", email, password }, 201, false);

    await call("Register same email again", "POST", "/api/users/register",
        { name: "Test User", email, password }, 409, false);

    await call("Login with wrong password", "POST", "/api/users/login",
        { email, password: "wrongpass" }, 401, false);

    const login = await call("Login", "POST", "/api/users/login",
        { email, password }, 200, false);
    token = login.token || "";

    await call("Get current user (/me)", "GET", "/api/users/me", null, 200);

    await call("Get posts without token", "GET", "/api/posts", null, 401, false);

    const created = await call("Create post", "POST", "/api/posts",
        { title: "My First Post", content: "My backend project is finally working!" }, 201);
    postId = created.post?._id || "";

    await call("Read all posts", "GET", "/api/posts", null, 200);
    await call("Read one post", "GET", `/api/posts/${postId}`, null, 200);

    await call("Update post", "PUT", `/api/posts/${postId}`,
        { title: "Updated Post", content: "I have successfully implemented CRUD operations." }, 200);

    const again = await call("Read post again (after update)", "GET", `/api/posts/${postId}`, null, 200);
    if (again.title !== "Updated Post") {
        failed++;
        console.log("FAIL  Title was not updated");
    }

    await call("Delete post", "DELETE", `/api/posts/${postId}`, null, 200);
    await call("Read post again (after delete)", "GET", `/api/posts/${postId}`, null, 404);

    console.log(failed === 0
        ? "\nALL TESTS PASSED. Your project is complete!"
        : `\n${failed} test(s) failed. Copy the FAIL lines above and send them to me.`);
}

run();