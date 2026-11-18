
import Post from "../models/post.model.js";

// CREATE POST
export const createPost = async (req, res) => {
    try {
        const { title, content } = req.body;

        const post = await Post.create({
            title,
            content,
            author: req.user._id
        });

        res.status(201).json({
            message: "Post created successfully",
            post
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// READ ALL POSTS
export const getPosts = async (req, res) => {
    try {
        const posts = await Post.find().populate("author", "name email");

        res.status(200).json(posts);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// READ SINGLE POST
export const getPostById = async (req, res) => {
    try {
        const post = await Post.findById(req.params.id)
            .populate("author", "name email");

        if (!post) {
            return res.status(404).json({ message: "Post not found" });
        }

        res.status(200).json(post);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// UPDATE POST
export const updatePost = async (req, res) => {
    try {
        const { title, content } = req.body;

        const post = await Post.findOneAndUpdate(
            { _id: req.params.id, author: req.user._id },
            { title, content },
            { new: true, runValidators: true }
        );

        if (!post) {
            return res.status(404).json({
                message: "Post not found or you are not authorized"
            });
        }

        res.status(200).json({
            message: "Post updated successfully",
            post
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// DELETE POST
export const deletePost = async (req, res) => {
    try {
        const post = await Post.findOneAndDelete({
            _id: req.params.id,
            author: req.user._id
        });

        if (!post) {
            return res.status(404).json({
                message: "Post not found or you are not authorized"
            });
        }

        res.status(200).json({
            message: "Post deleted successfully"
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
